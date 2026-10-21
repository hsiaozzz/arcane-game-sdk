import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { WebSocket } from 'ws';
import { attachScoreRaceServer, SCORE_RACE_ADAPTER } from '../server/score-race.mjs';
import { attachTurnMatchServer } from '../server/turn-match.mjs';
import { createMatchTicketService } from '../server/tokens.mjs';

const keys = generateKeyPairSync('ed25519');
const players = n => Array.from({ length: n }, (_, i) => 'gusr_' + (i + 1).toString(16).padStart(32, '0'));
function fixture(n, clock) {
  const match = { gameId: 'race', environment: 'development', releaseId: 'r1', matchRunId: 'round', adapterId: SCORE_RACE_ADAPTER,
    gameUserIds: players(n), createdAt: clock.at, state: null, stateVersion: 0, status: 'registered' };
  return { match, events: [], revoked: false, failSave: false, failSettle: false, maxStateBytes: 0, sessionChecks: 0, saves: 0,
    async dispatch(method, p) {
      if (method === 'admin.getSession') { this.sessionChecks++; return { revoked: this.revoked, expiresAt: clock.at + 3600000 }; }
      if (method === 'admin.activeMatches' || method === 'admin.pendingMatches') {
        if (p.adapterId !== SCORE_RACE_ADAPTER) return { matches: [], cursor: null };
        return { matches: match.status === 'settled' || (method === 'admin.pendingMatches' && !match.state?.pendingResult) ? [] : [structuredClone(match)], cursor: null };
      }
      if (method === 'admin.getMatch') { if (this.failRead) throw new Error('read unavailable'); return structuredClone(match); }
      if (method === 'admin.consumeMatchTicket') { this.nonces ||= new Set(); assert.ok(!this.nonces.has(p.nonce)); this.nonces.add(p.nonce); return { consumed: true }; }
      if (method === 'admin.saveMatchState') {
        if (this.failSave) throw new Error('test outage');
        this.saves++;
        assert.equal(match.stateVersion, p.expectedVersion);
        const bytes = Buffer.byteLength(JSON.stringify(p.state)); assert.ok(bytes <= 32768); this.maxStateBytes = Math.max(this.maxStateBytes, bytes);
        match.state = structuredClone(p.state); const stateVersion = ++match.stateVersion;
        if (this.commitThenThrow) { this.commitThenThrow = false; throw new Error('committed response lost'); }
        return { stateVersion };
      }
      if (method === 'admin.settleMatch') {
        if (this.failSettle) throw new Error('test outage');
        if (match.status !== 'settled') this.events.push(structuredClone(p));
        match.status = 'settled'; return { status: 'settled' };
      }
      throw new Error(method);
    } };
}
async function start(t, bridge, clock) {
  const server = http.createServer(), tickets = createMatchTicketService({ privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), now: () => clock.at });
  const service = attachScoreRaceServer({ server, bridge, tickets, now: () => clock.at, targetScore: 3, logger: { warn() {} }, otherPaths: ['/v1/matches'] });
  const turn = attachTurnMatchServer({ server, bridge, tickets, now: () => clock.at, logger: { warn() {} }, otherPaths: ['/v1/score-race'] });
  await service.recoverMatches(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let stopped = false;
  const close = async () => { if (stopped) return; stopped = true; await turn.close(); await service.close(); await new Promise(resolve => server.close(resolve)); };
  t.after(close);
  async function join(player) {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/score-race`), messages = [];
    const waits = new Set(); let totalBytes = 0;
    socket.on('message', raw => { totalBytes += raw.byteLength; const value = JSON.parse(raw.toString()); messages.push(value); for (const check of waits) check(); });
    const wait = predicate => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waits.delete(check); reject(new Error('WS timed out')); }, 8000);
      const check = () => { const value = messages.findLast(predicate); if (value) { clearTimeout(timeout); waits.delete(check); resolve(value); } }; waits.add(check); check();
    });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const signed = tickets.issue(player, { ...bridge.match, gameUserIds: undefined, state: undefined, config: undefined,
      adapterId: SCORE_RACE_ADAPTER, serverId: SCORE_RACE_ADAPTER, hostSessionId: 'session-' + player, actions: ['join', 'input', 'resume'] });
    socket.send(JSON.stringify({ type: 'join', ticket: signed.ticket })); await wait(v => v.type === 'joined');
    return { socket, messages, wait, get bytes() { return totalBytes; }, input(seq, challenge) { socket.send(JSON.stringify({ type: 'input', seq, input: { answer: challenge.target, challengeId: challenge.id } })); } };
  }
  return { ...service, close, join };
}

test('100 real WebSocket players wait for the complete roster, act, and receive server rankings', { timeout: 20000 }, async t => {
  const clock = { at: Date.now() }, bridge = fixture(100, clock), app = await start(t, bridge, clock), began = performance.now();
  const clients = await Promise.all(bridge.match.gameUserIds.slice(0, 99).map(app.join));
  assert.equal(bridge.match.state, null, '99 players cannot start a fixed 100-player match');
  clients.push(await app.join(bridge.match.gameUserIds[99]));
  const states = await Promise.all(clients.map(c => c.wait(v => v.type === 'state' && v.state.status === 'playing')));
  const joinedMs = performance.now() - began, latencies = [];
  const inputAt = performance.now();
  await Promise.all(clients.map(async (client, i) => { const at = performance.now(); client.input(1, states[i].state.challenge); await client.wait(v => v.type === 'state' && v.ack === 1); latencies.push(performance.now() - at); }));
  assert.equal(bridge.saves, 2, '100 simultaneous answers share one durable commit after the initial state');
  assert.equal(bridge.sessionChecks, 100, 'recent validated sessions avoid 100 per-input runtime calls');
  clock.at += 200;
  const winner = clients[0]; winner.input(2, winner.messages.findLast(v => v.type === 'state' && v.ack === 1).state.challenge);
  const next = await winner.wait(v => v.type === 'state' && v.ack === 2); clock.at += 200; winner.input(3, next.state.challenge);
  await Promise.all(clients.map(c => c.wait(v => v.type === 'state' && v.state.status === 'finished' && v.state.settlement === 'confirmed')));
  assert.equal(bridge.events.length, 1); assert.equal(bridge.events[0].results.length, 100);
  assert.deepEqual(bridge.events[0].results.map(r => r.rank), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(bridge.events[0].results[0].gameUserId, bridge.match.gameUserIds[0]); assert.equal(bridge.events[0].results.filter(r => r.won).length, 1);
  const publicFrame = winner.messages.findLast(v => v.type === 'state');
  for (const field of ['seq', 'lastActionAt', 'challengeIds', 'targets', 'pendingResult']) assert.equal(field in publicFrame.state, false);
  latencies.sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ backend: 'in-memory durable contract fixture; real HTTP+WS+Ed25519', players: 100,
    joinMs: Math.round(joinedMs), inputBurstMs: Math.round(performance.now() - inputAt), ackP50Ms: Math.round(latencies[49]), ackP95Ms: Math.round(latencies[94]),
    maxStateBytes: bridge.maxStateBytes, finalFrameBytes: Buffer.byteLength(JSON.stringify(publicFrame)), receivedBytes: clients.reduce((sum, c) => sum + c.bytes, 0), fanoutHz: 10 }));
});

test('answers require fresh server challenges, cooldowns and durable ACK; session revocation blocks input', async t => {
  const clock = { at: Date.now() }, bridge = fixture(2, clock), app = await start(t, bridge, clock), a = await app.join(bridge.match.gameUserIds[0]);
  const b = await app.join(bridge.match.gameUserIds[1]); await b.wait(v => v.state?.status === 'playing');
  const first = (await a.wait(v => v.state?.status === 'playing')).state.challenge;
  bridge.failSave = true; a.input(1, first); await a.wait(v => v.error?.code === 'INTERNAL_ERROR'); assert.equal(bridge.match.state.scores[0], 0);
  bridge.failSave = false; a.input(1, first); const acknowledged = await a.wait(v => v.ack === 1); assert.equal(bridge.match.state.scores[0], 1);
  a.input(2, first); await a.wait(v => v.error?.code === 'STALE_CHALLENGE');
  a.input(2, acknowledged.state.challenge); await a.wait(v => v.error?.code === 'INPUT_TOO_FAST');
  clock.at += 200; a.input(2, acknowledged.state.challenge); await a.wait(v => v.ack === 2);
  a.input(2, acknowledged.state.challenge); assert.equal(bridge.match.state.scores[0], 2);
  bridge.revoked = true; clock.at += 5001;
  a.input(3, a.messages.findLast(v => v.ack === 2).state.challenge); await a.wait(v => v.error?.code === 'SESSION_EXPIRED'); assert.equal(bridge.match.state.scores[0], 2);
  const closed = a.socket.readyState === WebSocket.CLOSED ? Promise.resolve(4401) : new Promise(resolve => a.socket.once('close', resolve));
  await app.checkSessions(); assert.equal(await closed, 4401);
});

test('a mixed input batch commits once, rejects bad challenges, and never ACKs a failed batch', async t => {
  const clock = { at: Date.now() }, bridge = fixture(3, clock), app = await start(t, bridge, clock);
  const clients = await Promise.all(bridge.match.gameUserIds.map(app.join));
  const initial = await Promise.all(clients.map(c => c.wait(v => v.state?.status === 'playing')));
  bridge.failSave = true;
  clients[0].input(1, initial[0].state.challenge); clients[1].input(1, initial[1].state.challenge);
  clients[2].input(1, { ...initial[2].state.challenge, id: 'stale' });
  await Promise.all([clients[0].wait(v => v.error?.code === 'INTERNAL_ERROR'), clients[1].wait(v => v.error?.code === 'INTERNAL_ERROR'), clients[2].wait(v => v.error?.code === 'STALE_CHALLENGE')]);
  assert.deepEqual(bridge.match.state.scores, [0, 0, 0]); assert.equal(bridge.saves, 1);
  assert.ok(clients.every(c => !c.messages.some(v => v.ack > 0)));
  bridge.failSave = false;
  clients[0].input(1, initial[0].state.challenge); clients[1].input(1, initial[1].state.challenge);
  await Promise.all(clients.slice(0, 2).map(c => c.wait(v => v.ack === 1)));
  assert.deepEqual(bridge.match.state.scores, [1, 1, 0]); assert.equal(bridge.saves, 2);
});

test('expired session checks run concurrently before one input commit and background revocation closes sockets', async t => {
  const clock = { at: Date.now() }, bridge = fixture(3, clock), original = bridge.dispatch;
  let active = 0, parallel = 0;
  bridge.dispatch = async function(method, params) {
    if (method === 'admin.getSession' && this.slowSessions) {
      active++; parallel = Math.max(parallel, active); await new Promise(resolve => setTimeout(resolve, 10)); active--;
    }
    return original.call(this, method, params);
  };
  const app = await start(t, bridge, clock), clients = await Promise.all(bridge.match.gameUserIds.map(app.join));
  const states = await Promise.all(clients.map(c => c.wait(v => v.state?.status === 'playing')));
  clock.at += 5001; bridge.slowSessions = true;
  clients.forEach((client, i) => client.input(1, states[i].state.challenge));
  await Promise.all(clients.map(c => c.wait(v => v.ack === 1))); assert.equal(parallel, 3); assert.equal(bridge.saves, 2);
  const closes = clients.map(c => new Promise(resolve => c.socket.once('close', resolve)));
  bridge.revoked = true; await app.checkSessions(); assert.deepEqual(await Promise.all(closes), [4401, 4401, 4401]);
});

test('a lost commit response reconciles durable state; a failed read blocks ACKs until in-process recovery', async t => {
  const clock = { at: Date.now() }, bridge = fixture(2, clock), app = await start(t, bridge, clock);
  const clients = await Promise.all(bridge.match.gameUserIds.map(app.join)), a = clients[0];
  const initial = await a.wait(v => v.state?.status === 'playing');
  bridge.commitThenThrow = true;
  a.input(1, initial.state.challenge); const one = await a.wait(v => v.ack === 1);
  assert.equal(bridge.match.state.scores[0], 1); assert.equal(app.rooms.values().next().value.version, 2);
  assert.ok(!a.messages.some(v => v.type === 'error'));
  clock.at += 200; bridge.commitThenThrow = true; bridge.failRead = true;
  a.input(2, one.state.challenge); const error = await a.wait(v => v.error?.code === 'INTERNAL_ERROR');
  assert.equal(error.error.recoverable, true); assert.equal(bridge.match.state.scores[0], 2);
  assert.ok(!a.messages.some(v => v.ack === 2), 'Unknown write outcome must never be ACKed');
  assert.equal(app.rooms.values().next().value.needsReconcile, true);
  assert.equal(a.socket.readyState, WebSocket.OPEN);
  bridge.failRead = false;
  // The old sequence is a read/retry hint, never another score grant.
  a.input(2, one.state.challenge); const two = await a.wait(v => v.ack === 2);
  assert.equal(bridge.match.state.scores[0], 2); assert.equal(app.rooms.values().next().value.version, 3);
  clock.at += 200; a.input(3, two.state.challenge);
  await a.wait(v => v.state?.status === 'finished' && v.state.settlement === 'confirmed');
  assert.equal(bridge.match.state.scores[0], 3); assert.equal(bridge.events.length, 1);
});

test('join timeout abandons 100 seats with no rewards; pending final state retries after restart', async t => {
  const clock = { at: Date.now() }, bridge = fixture(100, clock), first = await start(t, bridge, clock);
  bridge.failSettle = true; clock.at += 121000; await first.tick(); const frozen = structuredClone(bridge.match.state.pendingResult);
  assert.equal(frozen.results.length, 100); assert.ok(frozen.results.every(r => r.rank === null && r.score === 0 && r.points === 0 && !r.won));
  await first.close(); bridge.failSettle = false; const second = await start(t, bridge, clock); await second.retrySettlements();
  assert.equal(bridge.events.length, 1); assert.deepEqual(bridge.events[0], frozen);
});

test('recovery pages at most 20 large rooms per upstream response and continues after a failed settlement', async t => {
  const clock = { at: Date.now() }, bridge = fixture(100, clock), rooms = Array.from({ length: 41 }, (_, i) => ({
    ...structuredClone(bridge.match), matchRunId: 'page-' + i,
    state: { status: 'finished', scores: Array(100).fill(0), seq: Array(100).fill(0), pendingResult: { matchRunId: 'page-' + i } }, stateVersion: 1
  }));
  const pages = [], settled = [];
  bridge.dispatch = async (method, p) => {
    if (method === 'admin.activeMatches' && p.adapterId === SCORE_RACE_ADAPTER) {
      assert.equal(p.limit, 20); const offset = Number(p.after || 0); pages.push(offset);
      return { matches: rooms.slice(offset, offset + p.limit), cursor: offset + p.limit < rooms.length ? String(offset + p.limit) : null };
    }
    if (method === 'admin.activeMatches') return { matches: [], cursor: null };
    if (method === 'admin.settleMatch') { if (p.matchRunId === 'page-0') throw new Error('Persistent test outage'); settled.push(p.matchRunId); return {}; }
    throw new Error(method);
  };
  const app = await start(t, bridge, clock);
  assert.equal(app.rooms.size, 41); assert.deepEqual(pages, [0, 20, 40]); assert.equal(settled.length, 40);
  assert.ok(settled.includes('page-40'));
});
