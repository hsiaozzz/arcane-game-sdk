import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { platform, arch, cpus } from 'node:os';
import { WebSocket } from 'ws';
import { createNakamaBridge } from '../server/nakama.mjs';
import { createTokenService } from '../server/tokens.mjs';
import { ArcaneGame, createHttpTransport, createMatchConnection } from '../../packages/game-sdk/src/index.js';

// Operator-only load validation. Provisioning uses local server credentials to
// avoid weakening production auth/IP throttles for 100 clients on one machine.
// Actual queue/tickets/WS/input/results go through public SDK + gateway + Nakama.
process.loadEnvFile(new URL('../.local-data/platform.env', import.meta.url));
const count = Number(process.argv[2] || 100);
assert.ok(Number.isInteger(count) && count >= 2 && count <= 100, 'Player count must be 2..100');
const gateway = process.env.ARCANE_PUBLIC_URL || 'http://127.0.0.1:7400';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(gateway).hostname), 'Load test only accepts the isolated local stack');
const bridge = createNakamaBridge({ url: process.env.NAKAMA_URL, serverKey: process.env.NAKAMA_SERVER_KEY,
  httpKey: process.env.NAKAMA_HTTP_KEY, gatewayKey: process.env.ARCANE_GATEWAY_KEY, adminKey: process.env.ARCANE_ADMIN_KEY });
const tokens = createTokenService({ secret: process.env.ARCANE_TOKEN_SECRET });
const scope = { gameId: `score-load-${randomUUID().replaceAll('-', '')}`, environment: 'development', releaseId: 'load' };
const participants = [], sockets = [], sessions = [], latencies = [], started = performance.now();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return; await pause(10); }
  throw new Error('LOAD_TIMEOUT');
}
let receivedBytes = 0, frames = 0, maxFrameBytes = 0, successful = false, report;
try {
  await bridge.dispatch('admin.registerGame', { ...scope, publisherId: 'arcane-local-load', buildHash: 'trusted-score-load-v1',
    manifest: { schemaVersion: '1.0', sdkVersion: '0.1', capabilities: ['profile', 'matchmaking', 'match', 'leaderboards'],
      multiplayer: { adapter: 'score-race-v1', minPlayers: count, maxPlayers: count },
      leaderboards: { points: { sort: 'descending', period: 'all_time', metric: 'points', operator: 'sum', writePolicy: 'verified_match_result' } } } });
  for (let start = 0; start < count; start += 10) await Promise.all(Array.from({ length: Math.min(10, count - start) }, async () => {
    const identity = await bridge.authenticate({ deviceId: `load-${randomUUID()}` }), sessionId = randomUUID(); sessions.push(sessionId);
    await bridge.dispatch('admin.createSession', { sessionId, platformUserId: identity.id, expiresAt: Date.now() + 600000 });
    const gameToken = tokens.issue('arcane-game', identity.id, { ...scope, hostSessionId: sessionId, hostOrigin: new URL(gateway).origin }, 300000).token;
    const sdk = await ArcaneGame.connect({ transport: createHttpTransport({ gatewayUrl: gateway, gameToken }) });
    participants.push({ sdk, id: (await sdk.context.get()).gameUserId, state: null, ack: 0 });
  }));
  const queueAt = performance.now();
  await Promise.all(participants.map(async participant => { participant.queue = (await participant.sdk.matchmaking.join()).queue; }));
  await Promise.all(participants.map(async participant => {
    participant.queue = (await participant.sdk.matchmaking.status({ queueId: participant.queue.queueId })).queue;
    assert.equal(participant.queue.status, 'matched'); assert.equal(participant.queue.gameUserIds.length, count);
  }));
  const run = participants[0].queue.matchRunId;
  assert.ok(participants.every(p => p.queue.matchRunId === run));
  const queueMs = performance.now() - queueAt, joinAt = performance.now();
  class MeasuredSocket extends WebSocket {
    constructor(url) {
      super(url); this.on('message', data => { const bytes = data.byteLength; receivedBytes += bytes; frames++; maxFrameBytes = Math.max(maxFrameBytes, bytes); });
    }
  }
  await Promise.all(participants.map(async participant => {
    const ticket = await participant.sdk.match.ticket({ matchRunId: run });
    const connection = createMatchConnection(ticket, { WebSocketImpl: MeasuredSocket, timeoutMs: 30_000 }); sockets.push(connection);
    participant.connection = connection;
    connection.onState(({ state, ack }) => { participant.state = state; participant.ack = ack; });
    connection.on('error', error => { participant.error = error.code; });
    await connection.ready;
  }));
  await until(() => participants.every(p => p.state?.status === 'playing'));
  const joinMs = performance.now() - joinAt, burstAt = performance.now();
  await Promise.all(participants.map(async participant => {
    const at = performance.now(), challenge = participant.state.challenge;
    const seq = participant.connection.sendInput({ answer: challenge.target, challengeId: challenge.id });
    await until(() => participant.ack >= seq); latencies.push(performance.now() - at);
  }));
  const burstMs = performance.now() - burstAt, winner = participants[0];
  for (let step = 2; step <= 10; step++) {
    await pause(160); const challenge = winner.state.challenge;
    const seq = winner.connection.sendInput({ answer: challenge.target, challengeId: challenge.id });
    await until(() => winner.ack >= seq);
  }
  await until(() => participants.every(p => p.state?.status === 'finished' && p.state.settlement === 'confirmed'));
  const recovered = await participants[0].sdk.match.get({ matchRunId: run });
  assert.equal(recovered.result.results.length, count); assert.equal(recovered.state.players.length, count);
  assert.equal(recovered.result.results.find(result => result.gameUserId === winner.id).rank, 1);
  assert.ok(!participants.some(p => p.error));
  for (const forbidden of ['challengeIds', 'targets', 'lastActionAt', 'seq', 'pendingResult']) assert.equal(forbidden in recovered.state, false);
  const admin = await bridge.dispatch('admin.getMatch', { ...scope, matchRunId: run, adapterId: 'score-race-v1' });
  const durableStateBytes = Buffer.byteLength(JSON.stringify(admin.state)); assert.ok(durableStateBytes <= 32768);
  latencies.sort((a, b) => a - b);
  report = { date: new Date().toISOString(), backend: 'official Nakama + PostgreSQL + Gateway + SDK + Ed25519 + real WS',
    transport: 'loopback', os: `${platform()} ${arch()}`, cpu: cpus()[0]?.model, players: count, rosterAndResultSize: recovered.result.results.length,
    queueMs: Math.round(queueMs), joinMs: Math.round(joinMs), inputBurstMs: Math.round(burstMs),
    ackP50Ms: Math.round(latencies[Math.floor((count - 1) * .5)]), ackP95Ms: Math.round(latencies[Math.floor((count - 1) * .95)]),
    ackMaxMs: Math.round(latencies.at(-1)), maxFrameBytes, durableStateBytes, receivedBytes, receivedFrames: frames,
    durableStateVersion: admin.stateVersion, roomFanoutHzLimit: 10, inputWindowMs: 20, sessionCacheMs: 5000,
    elapsedMs: Math.round(performance.now() - started), passed: true };
  successful = true;
} catch (error) {
  // No URL, credential, identity, cookie or raw upstream payload in the report.
  report = { date: new Date().toISOString(), players: count, passed: false,
    code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || error.message || '') ? error.code || error.message : error.name || 'LOAD_FAILED' };
} finally {
  sockets.forEach(socket => socket.close()); participants.forEach(p => p.sdk.close());
  await Promise.allSettled(sessions.map(sessionId => bridge.dispatch('admin.revokeSession', { sessionId })));
  const directory = new URL('../.local-data/', import.meta.url); await mkdir(directory, { recursive: true });
  await writeFile(new URL('multiplayer-load-report.json', directory), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); if (!successful) process.exitCode = 1;
}
