import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { generateKeyPairSync } from 'node:crypto';
import { attachTurnMatchServer, TURN_ADAPTER } from '../server/turn-match.mjs';
import { createMatchTicketService } from '../server/tokens.mjs';

const PLAYERS = ['gusr_' + 'a'.repeat(32), 'gusr_' + 'b'.repeat(32)];
const keys = generateKeyPairSync('ed25519');
function durableBridge(matches) {
  return { matches, events: [], failSave: false, failSettle: false, revoked: false,
    async dispatch(method, p) {
      if (method === 'admin.getSession') return { revoked: this.revoked, expiresAt: Date.now() + 3600000 };
      if (method === 'admin.activeMatches') {
        const remaining = [...matches.values()].filter(m => m.status !== 'settled');
        const offset = Number(p.after || 0), page = remaining.slice(offset, offset + 1);
        return { matches: structuredClone(page), cursor: offset + 1 < remaining.length ? String(offset + 1) : null };
      }
      if (method === 'admin.pendingMatches') return { matches: [...matches.values()].filter(m => m.status !== 'settled' && m.state?.pendingResult) };
      const m = matches.get(p.matchRunId);
      assert.ok(m);
      if (method === 'admin.getMatch') return structuredClone(m);
      if (method === 'admin.consumeMatchTicket') {
        m.nonces ||= new Set(); assert.ok(!m.nonces.has(p.nonce)); m.nonces.add(p.nonce); return { consumed: true };
      }
      if (method === 'admin.saveMatchState') {
        if (this.failSave) throw new Error('storage unavailable');
        assert.equal(p.expectedVersion, m.stateVersion); assert.notEqual(m.status, 'settled');
        m.state = structuredClone(p.state); return { stateVersion: ++m.stateVersion };
      }
      if (method === 'admin.settleMatch') {
        if (this.failSettle) throw new Error('network unavailable');
        assert.deepEqual(m.state.pendingResult, p);
        if (m.status !== 'settled') this.events.push(structuredClone(p));
        m.status = 'settled'; return { status: 'settled' };
      }
      throw new Error(method);
    }
  };
}
function match(id, now, state = null) {
  return { gameId: 'test', environment: 'development', releaseId: 'r1', matchRunId: id, adapterId: TURN_ADAPTER,
    gameUserIds: PLAYERS, createdAt: now, state, stateVersion: state ? 1 : 0, status: 'registered' };
}
async function start(t, bridge, clock) {
  const server = http.createServer(), tickets = createMatchTicketService({ privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), now: () => clock.at });
  const service = attachTurnMatchServer({ server, bridge, tickets, now: () => clock.at, logger: { warn() {} } });
  await service.recoverMatches();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await service.close(); await new Promise(r => server.close(r)); };
  t.after(close);
  async function join(id, player) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/matches`), messages = [];
    let waiter;
    ws.on('message', bytes => { const v = JSON.parse(bytes.toString()); messages.push(v); waiter?.(); });
    const wait = predicate => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('socket message timed out')), 4000);
      const check = () => { const value = messages.find(predicate); if (value) { clearTimeout(timeout); waiter = null; resolve(value); } };
      waiter = check; check();
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const signed = tickets.issue(player, { gameId: 'test', environment: 'development', releaseId: 'r1', matchRunId: id,
      adapterId: TURN_ADAPTER, serverId: TURN_ADAPTER, hostSessionId: 'session-test', actions: ['join', 'input', 'resume'] });
    ws.send(JSON.stringify({ type: 'join', ticket: signed.ticket }));
    await wait(v => v.type === 'joined');
    return { ws, messages, wait, send: (seq, take) => ws.send(JSON.stringify({ type: 'input', seq, input: { take } })) };
  }
  return { ...service, close, join };
}

test('recovery paginates null/playing states, applies saved deadlines, and abandons absent players without rewards', async t => {
  const clock = { at: Date.now() }, playing = { status: 'playing', stones: 12, maxTake: 3, turn: PLAYERS[0], seqByPlayer: {}, deadline: clock.at - 1 };
  const bridge = durableBridge(new Map([['waiting', match('waiting', clock.at - 121000)], ['playing', match('playing', clock.at - 5000, playing)]]));
  const app = await start(t, bridge, clock);
  assert.equal(app.rooms.size, 2);
  await app.tick();
  assert.equal(bridge.events.length, 2);
  assert.equal(bridge.events.find(e => e.matchRunId === 'playing').results[1].won, true);
  const abandoned = bridge.events.find(e => e.matchRunId === 'waiting');
  assert.equal(abandoned.reason, 'abandoned');
  assert.ok(abandoned.results.every(r => r.rank === null && r.points === 0 && r.score === 0 && !r.won));
});

test('finished result survives settlement outage and process restart with one frozen event', async t => {
  const clock = { at: Date.now() }, bridge = durableBridge(new Map([['one', match('one', clock.at, {
    status: 'playing', stones: 3, maxTake: 3, turn: PLAYERS[0], seqByPlayer: {}, deadline: clock.at - 1 })]]));
  bridge.failSettle = true;
  const first = await start(t, bridge, clock); await first.tick();
  const frozen = structuredClone(bridge.matches.get('one').state.pendingResult);
  assert.equal(bridge.events.length, 0); await first.close();
  bridge.failSettle = false;
  const second = await start(t, bridge, clock);
  assert.deepEqual(bridge.events, [frozen]);
  await second.retrySettlements(); await second.recoverMatches();
  assert.equal(bridge.events.length, 1);
});

test('both sockets must arrive; turn validation and ACK ignore duplicated input', async t => {
  const clock = { at: Date.now() }, bridge = durableBridge(new Map([['two', match('two', clock.at)]]));
  const app = await start(t, bridge, clock), a = await app.join('two', PLAYERS[0]);
  assert.equal((await a.wait(v => v.type === 'state')).state.status, 'waiting');
  a.send(1, 1); await a.wait(v => v.type === 'error' && v.error.code === 'MATCH_NOT_STARTED');
  const b = await app.join('two', PLAYERS[1]);
  await a.wait(v => v.type === 'state' && v.state.status === 'playing');
  b.send(1, 3); assert.ok((await b.wait(v => v.type === 'error' && v.error.code === 'NOT_YOUR_TURN')).error.recoverable);
  a.send(1, 4); await a.wait(v => v.type === 'error' && v.error.code === 'INVALID_MOVE');
  a.send(1, 3); await a.wait(v => v.type === 'state' && v.ack === 1);
  a.send(1, 3); await b.wait(v => v.type === 'state' && v.state.stones === 18);
  assert.equal(bridge.matches.get('two').state.stones, 18); assert.equal(bridge.matches.get('two').stateVersion, 2);
});

test('failed durable move is never broadcast or acknowledged', async t => {
  const clock = { at: Date.now() }, bridge = durableBridge(new Map([['three', match('three', clock.at)]]));
  const app = await start(t, bridge, clock), a = await app.join('three', PLAYERS[0]); await app.join('three', PLAYERS[1]);
  await a.wait(v => v.type === 'state' && v.state.status === 'playing');
  bridge.failSave = true; a.send(1, 2); await a.wait(v => v.type === 'error');
  assert.equal(bridge.matches.get('three').state.stones, 21); assert.ok(!a.messages.some(v => v.ack === 1));
  bridge.failSave = false; a.send(1, 2); await a.wait(v => v.type === 'state' && v.ack === 1);
  assert.equal(bridge.matches.get('three').state.stones, 19);
});

test('a committed move with a lost save response is reconciled before ACK and the next turn still commits', async t => {
  const clock = { at: Date.now() }, bridge = durableBridge(new Map([['lost-response', match('lost-response', clock.at)]]));
  const dispatch = bridge.dispatch;
  let loseResponse = false;
  bridge.dispatch = async function(method, params) {
    const result = await dispatch.call(this, method, params);
    if (method === 'admin.saveMatchState' && loseResponse) { loseResponse = false; throw new Error('response lost after commit'); }
    return result;
  };
  const app = await start(t, bridge, clock), a = await app.join('lost-response', PLAYERS[0]), b = await app.join('lost-response', PLAYERS[1]);
  await a.wait(v => v.type === 'state' && v.state.status === 'playing');
  loseResponse = true; a.send(1, 2);
  await a.wait(v => v.type === 'state' && v.ack === 1);
  assert.equal(bridge.matches.get('lost-response').state.stones, 19);
  assert.equal([...app.rooms.values()][0].version, 2);
  b.send(1, 3); await b.wait(v => v.type === 'state' && v.ack === 1);
  assert.equal(bridge.matches.get('lost-response').state.stones, 16);
  assert.equal(bridge.matches.get('lost-response').stateVersion, 3);
  assert.equal(a.messages.some(v => v.type === 'error'), false);
});

test('an unconfirmed committed move is not ACKed until a later input or recovery can read durable state', async t => {
  const clock = { at: Date.now() }, bridge = durableBridge(new Map([['uncertain', match('uncertain', clock.at)]]));
  const dispatch = bridge.dispatch;
  let loseResponse = false, denyRead = false;
  bridge.dispatch = async function(method, params) {
    if (method === 'admin.getMatch' && denyRead) throw new Error('reconciliation unavailable');
    const result = await dispatch.call(this, method, params);
    if (method === 'admin.saveMatchState' && loseResponse) { loseResponse = false; throw new Error('response lost after commit'); }
    return result;
  };
  const app = await start(t, bridge, clock), a = await app.join('uncertain', PLAYERS[0]), b = await app.join('uncertain', PLAYERS[1]);
  await a.wait(v => v.type === 'state' && v.state.status === 'playing');
  loseResponse = true; denyRead = true; a.send(1, 2); await a.wait(v => v.type === 'error');
  const room = [...app.rooms.values()][0];
  assert.equal(bridge.matches.get('uncertain').state.stones, 19); assert.equal(room.state.stones, 21);
  assert.equal(room.needsReconcile, true); assert.ok(!a.messages.some(v => v.ack === 1));
  denyRead = false;
  a.send(1, 2); await a.wait(v => v.type === 'state' && v.ack === 1); await b.wait(v => v.state?.stones === 19);
  assert.equal(room.version, 2); assert.equal(room.needsReconcile, false);
  b.send(1, 1); await b.wait(v => v.type === 'state' && v.ack === 1); assert.equal(room.state.stones, 18);

  const marker = a.messages.length;
  loseResponse = true; denyRead = true; a.send(2, 1);
  await a.wait(v => a.messages.indexOf(v) >= marker && v.type === 'error');
  assert.ok(!a.messages.some(v => v.ack === 2)); assert.equal(room.version, 3);
  denyRead = false; await app.recoverMatches();
  await a.wait(v => v.type === 'state' && v.ack === 2); await b.wait(v => v.state?.stones === 17);
  assert.equal(room.version, 4); assert.equal(room.needsReconcile, false);
  b.send(2, 1); await b.wait(v => v.type === 'state' && v.ack === 2);
  assert.equal(bridge.matches.get('uncertain').state.stones, 16); assert.equal(room.version, 5);
});

test('session revocation closes an existing match socket without accepting further moves', async t => {
  const clock = { at: Date.now() }, bridge = durableBridge(new Map([['revoked', match('revoked', clock.at)]]));
  const app = await start(t, bridge, clock), a = await app.join('revoked', PLAYERS[0]); await app.join('revoked', PLAYERS[1]);
  await a.wait(v => v.type === 'state' && v.state.status === 'playing');
  bridge.revoked = true;
  a.send(1, 2); await a.wait(v => v.type === 'error' && v.error.code === 'SESSION_EXPIRED');
  assert.equal(bridge.matches.get('revoked').state.stones, 21);
  const closed = new Promise(resolve => a.ws.once('close', code => resolve(code)));
  await app.checkSessions(); assert.equal(await closed, 4401);
});
