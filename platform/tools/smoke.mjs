import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket } from 'ws';
import { ArcaneGame, createHttpTransport, createMatchConnection } from '../../packages/game-sdk/src/index.js';
import { createNakamaBridge } from '../server/nakama.mjs';
import { createTokenService } from '../server/tokens.mjs';

// Only the isolated development stack is accepted. Credentials never reach the report.
const root = fileURLToPath(new URL('../../', import.meta.url));
process.loadEnvFile(path.join(root, 'platform/.local-data/platform.env'));
const gateway = new URL(process.env.ARCANE_PUBLIC_URL).origin;
assert.ok(process.env.ARCANE_LOCAL_DEVELOPMENT === 'true' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(gateway).hostname), 'Smoke tests only accept the isolated local development stack');
const origin = gateway;
const scope = { gameId: 'arcane-take-away', environment: 'development', releaseId: 'dev' };
const secondScope = { ...scope, gameId: 'arcane-score-race' };
const startedAt = new Date().toISOString();
const start = performance.now();
const results = [], clients = new Set(), sockets = new Set(), connections = new Set(), createdHosts = [];
let completed = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : error?.name === 'AssertionError' ? 'ASSERTION_FAILED' : 'SMOKE_FAILED';
function failure(code) { return Object.assign(new Error(code), { code }); }
async function eventually(predicate, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await predicate();
    if (result) return result;
    await pause(30);
  }
  throw failure('SMOKE_TIMEOUT');
}
async function run(name, task) {
  const at = performance.now();
  try {
    await task();
    results.push({ name, status: 'passed', durationMs: Math.round(performance.now() - at) });
    console.log(`PASS ${name}`);
  } catch (error) {
    const code = safeCode(error);
    results.push({ name, status: 'failed', code, durationMs: Math.round(performance.now() - at) });
    console.error(`FAIL ${name} (${code})`);
    throw failure('SMOKE_STOPPED');
  }
}
async function expectError(operation, codes) {
  let rejected = false;
  try { await operation(); }
  catch (error) {
    rejected = true;
    assert.ok(codes.includes(error.code), 'Unexpected rejection code');
  }
  assert.ok(rejected, 'Operation unexpectedly succeeded');
}
async function post(route, body = {}, { cookie, token, requestOrigin = origin } = {}) {
  const response = await fetch(`${gateway}${route}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
    headers: { 'Content-Type': 'application/json', Origin: requestOrigin,
      ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let data;
  try { data = await response.json(); } catch { throw failure('INVALID_GATEWAY_JSON'); }
  if (!response.ok || data.error) throw Object.assign(failure(data.error?.code || 'GATEWAY_ERROR'), { status: response.status });
  return { data, cookie: response.headers.getSetCookie?.()[0]?.split(';')[0] };
}
async function guest() {
  const { cookie } = await post('/v1/session');
  assert.ok(cookie?.startsWith('arcane_host_session='));
  const host = { cookie };
  createdHosts.push(host);
  return host;
}
async function gameClient(host, context = scope) {
  const { data } = await post('/v1/bootstrap', context, host);
  const transport = createHttpTransport({ gatewayUrl: gateway, gameToken: data.gameToken,
    fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Origin: origin } }) });
  const sdk = await ArcaneGame.connect({ transport });
  clients.add(sdk);
  return { sdk, token: data.gameToken, context: data.context };
}
function connectMatch(ticket, refreshTicket) {
  const tracked = [];
  class TrackedSocket extends WebSocket {
    constructor(url) { super(url); tracked.push(this); sockets.add(this); this.on('error', () => {}); }
  }
  const connection = createMatchConnection(ticket, { WebSocketImpl: TrackedSocket, timeoutMs: 8000,
    maxReconnectAttempts: 3, refreshTicket });
  const peer = { connection, tracked, packets: [], errors: [], statuses: [], latest: null };
  connection.onState(packet => { peer.latest = packet; peer.packets.push(packet); if (peer.packets.length > 80) peer.packets.shift(); });
  connection.on('error', error => peer.errors.push(error.code));
  connection.on('status', value => peer.statuses.push(value.status));
  connections.add(connection);
  return peer;
}
try {
  const bridge = createNakamaBridge({ url: process.env.NAKAMA_URL, serverKey: process.env.NAKAMA_SERVER_KEY,
    httpKey: process.env.NAKAMA_HTTP_KEY, gatewayKey: process.env.ARCANE_GATEWAY_KEY, adminKey: process.env.ARCANE_ADMIN_KEY });
  let hosts, games, otherGames, profiles, party, queue, peers, finished, frozenEvent, winner, winnerSdk;

  await run('live backend health and trusted guest sessions', async () => {
    assert.equal((await fetch(`${gateway}/v1/health`).then(response => response.json())).status, 'ok');
    await bridge.health();
    hosts = await Promise.all([guest(), guest()]);
    assert.notEqual(hosts[0].cookie, hosts[1].cookie);
    games = await Promise.all(hosts.map(host => gameClient(host)));
    assert.ok(games.every(game => /^gusr_[0-9a-f]{32}$/.test(game.context.gameUserId)));
    assert.notEqual(games[0].context.gameUserId, games[1].context.gameUserId);
  });

  await run('Chinese profile update uses compare-and-swap', async () => {
    profiles = await Promise.all(games.map(game => game.sdk.profile.get()));
    const before = profiles[0];
    const updated = await games[0].sdk.profile.update({ displayName: '扫地烟火测试员', expectedVersion: before.version });
    assert.equal(updated.displayName, '扫地烟火测试员');
    assert.equal(updated.version, before.version + 1);
    await expectError(() => games[0].sdk.profile.update({ displayName: '旧版本不能覆盖', expectedVersion: before.version }), ['PROFILE_VERSION_CONFLICT']);
    assert.equal((await games[0].sdk.profile.get()).displayName, updated.displayName);
  });

  await run('save create/update conflicts and per-player isolation', async () => {
    const sdk = games[0].sdk;
    const saved = await sdk.storage.write({ collection: 'default', key: 'smoke_progress', value: { stage: 1, label: '星石' }, expectedVersion: 0 });
    assert.equal(saved.version, 1);
    await expectError(() => sdk.storage.write({ collection: 'default', key: 'smoke_progress', value: { stage: 99 }, expectedVersion: 0 }), ['SAVE_VERSION_CONFLICT']);
    const updated = await sdk.storage.write({ collection: 'default', key: 'smoke_progress', value: { stage: 2, label: '星石' }, expectedVersion: saved.version });
    assert.equal(updated.version, 2);
    assert.equal((await games[1].sdk.storage.read({ collection: 'default', key: 'smoke_progress' })).item, null);
  });

  await run('same host receives isolated second-game identity and save scope', async () => {
    otherGames = await Promise.all(hosts.map(host => gameClient(host, secondScope)));
    assert.notEqual(otherGames[0].context.gameUserId, games[0].context.gameUserId);
    assert.notEqual(otherGames[1].context.gameUserId, games[1].context.gameUserId);
    assert.equal((await otherGames[0].sdk.storage.read({ collection: 'default', key: 'smoke_progress' })).item, null);
    const forged = await games[0].sdk.context.get({ gameId: 'arcane-score-race', platformUserId: 'not-an-authorized-subject' });
    assert.equal(forged.gameId, scope.gameId);
    assert.equal(forged.gameUserId, games[0].context.gameUserId);
    const value = await games[0].sdk.storage.read({ collection: 'default', key: 'smoke_progress', gameId: 'arcane-score-race' });
    assert.equal(value.value.stage, 2);
    await expectError(() => games[0].sdk.profile.get({ gameUserId: otherGames[0].context.gameUserId }), ['PLAYER_NOT_FOUND']);
  });

  await run('friend request acceptance and authorized private chat', async () => {
    const [a, b] = games.map(game => game.sdk), [aid, bid] = games.map(game => game.context.gameUserId);
    assert.equal((await a.friends.request({ gameUserId: bid })).status, 'requested');
    assert.ok((await b.friends.list()).incoming.some(friend => friend.gameUserId === aid));
    assert.equal((await b.friends.accept({ gameUserId: aid })).status, 'accepted');
    assert.ok((await a.friends.list()).friends.some(friend => friend.gameUserId === bid));
    const channel = (await a.chat.channels()).channels.find(channel => channel.type === 'dm' && channel.gameUserId === bid);
    assert.ok(channel);
    const sent = (await a.chat.send({ channelId: channel.channelId, text: '一起扫地，星石见！' })).message;
    const received = await b.chat.history({ channelId: channel.channelId });
    assert.ok(received.messages.some(message => message.id === sent.id && message.text === '一起扫地，星石见！'));
    assert.equal((await otherGames[0].sdk.friends.list()).friends.length, 0);
    await expectError(() => otherGames[0].sdk.chat.history({ channelId: channel.channelId }), ['CHANNEL_ACCESS_DENIED']);
  });

  await run('Party invitation acceptance and ready state persist', async () => {
    party = (await games[0].sdk.party.create()).party;
    await games[0].sdk.party.invite({ partyId: party.partyId, gameUserId: games[1].context.gameUserId });
    assert.ok((await games[1].sdk.party.get()).invites.some(invite => invite.partyId === party.partyId));
    const accepted = (await games[1].sdk.party.accept({ partyId: party.partyId })).party;
    assert.equal(accepted.members.filter(member => member.status === 'member').length, 2);
    await games[1].sdk.party.ready({ partyId: party.partyId, ready: true });
    assert.equal((await games[0].sdk.party.get()).party.members.find(member => member.gameUserId === games[1].context.gameUserId).ready, true);
  });

  await run('real matchmaking freezes a two-player authoritative roster', async () => {
    const first = await games[0].sdk.matchmaking.join();
    assert.equal(first.queue.status, 'waiting');
    const second = await games[1].sdk.matchmaking.join();
    assert.equal(second.queue.status, 'matched');
    queue = (await games[0].sdk.matchmaking.status()).queue;
    assert.equal(queue.matchRunId, second.queue.matchRunId);
    const match = await games[0].sdk.match.get({ matchRunId: queue.matchRunId });
    assert.deepEqual([...match.gameUserIds].sort(), games.map(game => game.context.gameUserId).sort());
    assert.equal(match.adapterId, 'turn-based-v1');
  });

  await run('SDK match sockets join and reject out-of-turn input recoverably', async () => {
    const tickets = await Promise.all(games.map(game => game.sdk.match.ticket({ matchRunId: queue.matchRunId })));
    peers = tickets.map((ticket, index) => connectMatch(ticket, () => games[index].sdk.match.ticket({ matchRunId: queue.matchRunId })));
    await Promise.all(peers.map(peer => peer.connection.ready));
    await eventually(() => peers.every(peer => peer.latest?.state.status === 'playing'));
    const state = peers[0].latest.state;
    assert.equal(state.status, 'playing');
    assert.equal(state.stones, 21);
    const wrong = peers[games.findIndex(game => game.context.gameUserId !== state.turn)];
    wrong.connection.sendInput({ take: 1 });
    await eventually(() => wrong.errors.includes('NOT_YOUR_TURN'));
    assert.equal(wrong.connection.status, 'connected');
    assert.equal(wrong.latest.state.stones, 21);
  });

  await run('fresh-ticket reconnect preserves acknowledged input sequence', async () => {
    const moving = games.findIndex(game => game.context.gameUserId === peers[0].latest.state.turn);
    const peer = peers[moving];
    const seq = peer.connection.sendInput({ take: 1 });
    await eventually(() => peer.latest.ack === seq && peer.latest.state.move === 1);
    const beforeCount = peer.tracked.length;
    peer.tracked.at(-1).terminate();
    await eventually(() => peer.tracked.length > beforeCount && peer.connection.status === 'connected' && peer.latest.ack === seq);
    assert.equal(peer.latest.state.move, 1, 'Old input was replayed');
    assert.ok(peer.statuses.includes('reconnecting'));
    const other = peers[1 - moving];
    other.connection.sendInput({ take: 1 });
    await eventually(() => peer.latest.state.move === 2);
    const resumedSeq = peer.connection.sendInput({ take: 1 });
    assert.ok(resumedSeq > seq);
    await eventually(() => peer.latest.ack === resumedSeq && peer.latest.state.move === 3);
  });

  await run('legal alternating moves complete and persist the real match', async () => {
    for (let steps = 0; steps < 30; steps++) {
      const state = peers[0].latest.state;
      if (state.status === 'finished') break;
      const index = games.findIndex(game => game.context.gameUserId === state.turn);
      const move = state.move;
      peers[index].connection.sendInput({ take: Math.min(3, state.stones) });
      await eventually(() => peers[0].latest.state.move > move);
    }
    finished = peers[0].latest.state;
    assert.equal(finished.status, 'finished');
    assert.equal(finished.stones, 0);
    assert.equal(finished.reason, 'last_stone');
    await eventually(async () => (await games[0].sdk.match.get({ matchRunId: queue.matchRunId })).status === 'settled');
    const saved = await bridge.dispatch('admin.getMatch', { ...scope, matchRunId: queue.matchRunId });
    frozenEvent = saved.state.pendingResult;
    assert.ok(frozenEvent && frozenEvent.reason === 'finished');
    winner = games.findIndex(game => game.context.gameUserId === finished.winner);
    assert.ok(winner >= 0);
    winnerSdk = games[winner].sdk;
  });

  await run('leaderboards and achievements reflect only authoritative results', async () => {
    for (let index = 0; index < games.length; index++) {
      const expected = index === winner ? 100 : 25;
      const points = await games[index].sdk.leaderboards.list({ leaderboardId: 'points' });
      assert.equal(points.ownRecord.score, expected);
      assert.ok(points.ownRecord.rank >= 1);
      const achievements = (await games[index].sdk.achievements.list()).achievements;
      assert.equal(achievements.find(item => item.id === 'first_match').completed, true);
      assert.equal(achievements.find(item => item.id === 'first_win').completed, index === winner);
      assert.equal((await games[index].sdk.economy.get()).currencies.coins, 0);
    }
  });

  await run('concurrent achievement claims grant currency exactly once', async () => {
    const claims = await Promise.all(Array.from({ length: 5 }, () => winnerSdk.achievements.claim({ achievementId: 'first_win' })));
    assert.equal(claims.filter(claim => claim.duplicate === false).length, 1);
    assert.ok(claims.every(claim => claim.balance === 100));
    assert.equal((await winnerSdk.economy.get()).currencies.coins, 100);
    await winnerSdk.achievements.claim({ achievementId: 'first_match' });
    assert.equal((await winnerSdk.economy.get()).currencies.coins, 120);
  });

  await run('frozen settlement retries are idempotent and conflicting retries fail', async () => {
    const duplicate = await bridge.dispatch('admin.settleMatch', frozenEvent);
    assert.equal(duplicate.duplicate, true);
    const token = createTokenService({ secret: process.env.ARCANE_TOKEN_SECRET }).issue('arcane-workload', 'local-smoke-turn', {
      ...scope, adapterId: 'turn-based-v1', actions: ['get', 'settle'] }, 60_000).token;
    assert.equal((await post('/v1/servers/matches/settle', frozenEvent, { token })).data.duplicate, true);
    const conflict = structuredClone(frozenEvent);
    conflict.results[0].points++;
    await expectError(() => post('/v1/servers/matches/settle', conflict, { token }), ['SETTLEMENT_REPLAY_CONFLICT']);
    const points = await winnerSdk.leaderboards.list({ leaderboardId: 'points' });
    assert.equal(points.ownRecord.score, 100);
    assert.equal((await winnerSdk.economy.get()).currencies.coins, 120);
    await expectError(() => post('/v1/rpc', { method: 'admin.settleMatch', params: frozenEvent }, { token: games[0].token }), ['METHOD_FORBIDDEN']);
    assert.equal(games[0].sdk.match.settle, undefined);
  });

  await run('untrusted origins cannot create platform sessions', async () => {
    for (const requestOrigin of ['null', 'https://evil.invalid'])
      await expectError(() => post('/v1/session', {}, { requestOrigin }), ['ORIGIN_FORBIDDEN']);
    await expectError(() => post('/v1/rpc', { method: 'context.get' }, { token: games[0].token, requestOrigin: 'https://evil.invalid' }), ['ORIGIN_FORBIDDEN']);
  });

  await run('host logout immediately revokes existing scoped game bearers', async () => {
    await post('/v1/logout', {}, hosts[0]);
    await expectError(() => games[0].sdk.profile.get(), ['SESSION_EXPIRED', 'SESSION_EXPIRED_OR_REVOKED']);
    await expectError(() => otherGames[0].sdk.context.get(), ['SESSION_EXPIRED', 'SESSION_EXPIRED_OR_REVOKED']);
    assert.equal((await games[1].sdk.context.get()).gameId, scope.gameId);
    await post('/v1/logout', {}, hosts[1]);
  });
  completed = true;
} catch (error) {
  if (error.code !== 'SMOKE_STOPPED') {
    const code = safeCode(error);
    results.push({ name: 'smoke setup', status: 'failed', code, durationMs: 0 });
    console.error(`FAIL smoke setup (${code})`);
  }
} finally {
  for (const connection of connections) connection.close();
  for (const socket of sockets) { try { socket.terminate(); } catch { /* Already closed. */ } }
  for (const client of clients) client.close();
  await Promise.allSettled(createdHosts.map(host => post('/v1/logout', {}, host)));
  const report = { startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start),
    target: 'isolated-local-development', backend: 'real-nakama-postgresql', sdk: '@arcane/game-sdk', completed,
    passed: results.filter(result => result.status === 'passed').length, failed: results.filter(result => result.status === 'failed').length, results };
  await mkdir(path.join(root, 'platform/.local-data'), { recursive: true });
  await writeFile(path.join(root, 'platform/.local-data/smoke-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Smoke: ${report.passed} passed, ${report.failed} failed (${report.durationMs}ms). Sanitized report saved.`);
  if (!completed || report.failed) process.exitCode = 1;
}
