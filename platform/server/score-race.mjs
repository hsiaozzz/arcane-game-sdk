import { randomBytes, randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';
import { assert, publicError } from './errors.mjs';

export const SCORE_RACE_ADAPTER = 'score-race-v1';
export const SCORE_RACE_MAX_PLAYERS = 100;
const send = (ws, value) => {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 64 * 1024) { ws.close(4429, 'Slow consumer'); return; }
  ws.send(JSON.stringify(value));
};
const recoverable = new Set(['MATCH_NOT_STARTED', 'MATCH_FINISHED', 'INVALID_INPUT', 'STALE_CHALLENGE', 'INCORRECT_ANSWER', 'INPUT_TOO_FAST']);

/** A simple platform-owned reaction game, not arbitrary client-side score sync.
 * Each accepted answer consumes one challenge; targets, scores and rankings are
 * server-owned. Compact parallel arrays keep 100-player durable state <32KiB. */
export function attachScoreRaceServer({ server, bridge, tickets, now = Date.now, path = '/v1/score-race',
  otherPaths = [], targetScore = 10, cooldownMs = 150, roundMs = 60_000, joinMs = 120_000,
  inputWindowMs = 20, sessionCacheMs = 5000, logger = console }) {
  assert(Number.isInteger(targetScore) && targetScore >= 1 && targetScore <= 100, 'INVALID_RULES', 'Invalid target score');
  assert(Number.isInteger(cooldownMs) && cooldownMs >= 50, 'INVALID_RULES', 'Invalid cooldown');
  assert(Number.isInteger(inputWindowMs) && inputWindowMs >= 5 && inputWindowMs <= 50, 'INVALID_RULES', 'Invalid input window');
  assert(Number.isInteger(sessionCacheMs) && sessionCacheMs >= 0 && sessionCacheMs <= 5000, 'INVALID_RULES', 'Invalid session cache');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const rooms = new Map(), locks = new Map(), drains = new Set();
  let stopping = false, recovering, retrying = false;
  const keyFor = v => `${v.gameId}/${v.environment}/${v.matchRunId}`;
  const scope = v => ({ gameId: v.gameId, environment: v.environment, releaseId: v.releaseId,
    matchRunId: v.matchRunId, adapterId: SCORE_RACE_ADAPTER });
  function serial(key, fn) {
    const next = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    locks.set(key, next);
    return next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
  }
  async function validSession(claims) {
    assert(typeof claims.hostSessionId === 'string', 'SESSION_EXPIRED', 'Missing login session', 401);
    const session = await bridge.dispatch('admin.getSession', { sessionId: claims.hostSessionId });
    assert(session && !session.revoked && session.expiresAt > now(), 'SESSION_EXPIRED', 'Login session ended', 401);
  }
  function cache(match) {
    assert(match.adapterId === SCORE_RACE_ADAPTER && match.gameUserIds?.length >= 2 && match.gameUserIds.length <= SCORE_RACE_MAX_PLAYERS,
      'MATCH_FORBIDDEN', 'Match does not fit this adapter', 403);
    const room = { key: keyFor(match), context: scope(match), players: match.gameUserIds,
      state: match.state || null, version: match.stateVersion || 0, sockets: new Map(), inputQueue: [],
      createdAt: match.createdAt, touchedAt: now() };
    rooms.set(room.key, room); return room;
  }
  async function getRoom(claims) {
    let room = rooms.get(keyFor(claims));
    if (!room) room = cache(await bridge.dispatch('admin.getMatch', scope(claims)));
    assert(room.context.releaseId === claims.releaseId, 'MATCH_FORBIDDEN', 'Wrong release', 403);
    if (room.needsReconcile) await reconcile(room);
    return room;
  }
  function adopt(room, match) {
    assert(keyFor(match) === room.key && match.adapterId === SCORE_RACE_ADAPTER && match.releaseId === room.context.releaseId &&
      isDeepStrictEqual(match.gameUserIds, room.players) && Number.isInteger(match.stateVersion) && match.stateVersion >= room.version,
    'BACKEND_ERROR', 'Invalid durable reconciliation', 502);
    room.state = match.state ? (match.status === 'settled' ? { ...match.state, pendingResult: null } : match.state) : null;
    room.version = match.stateVersion; room.needsReconcile = false; room.touchedAt = now();
  }
  async function reconcile(room) {
    const match = await bridge.dispatch('admin.getMatch', room.context);
    adopt(room, match); return match;
  }
  function snapshot(room, user) {
    const i = room.players.indexOf(user), s = room.state;
    const state = s ? { status: s.status, players: room.players, scores: s.scores, targetScore: s.targetScore,
      deadline: s.deadline, startedAt: s.startedAt, finishedAt: s.finishedAt, winner: s.winner,
      reason: s.reason, settlement: s.pendingResult ? 'pending' : 'confirmed',
      ...(s.status === 'playing' ? { challenge: { id: s.challengeIds[i], target: s.targets[i] } } : {}) }
      : { status: 'waiting', players: room.players, connected: room.sockets.size, required: room.players.length };
    return { type: 'state', state, ack: s?.seq[i] || 0, serverTime: now() };
  }
  function flush(room) { for (const [user, ws] of room.sockets) send(ws, snapshot(room, user)); }
  // Coalesce room-wide fanout at 10Hz. Acting players get their durable ACK
  // after their short input batch commits, without waiting for room fanout.
  function broadcast(room, immediate = false) {
    if (immediate) { clearTimeout(room.broadcastTimer); room.broadcastTimer = null; flush(room); return; }
    if (!room.broadcastTimer) {
      room.broadcastTimer = setTimeout(() => { room.broadcastTimer = null; flush(room); }, 100);
      room.broadcastTimer.unref?.();
    }
  }
  async function save(room, state) {
    const previous = room.version;
    try {
      const result = await bridge.dispatch('admin.saveMatchState', { ...room.context, expectedVersion: previous, state });
      const version = result.stateVersion ?? result.version;
      assert(version === previous + 1, 'BACKEND_ERROR', 'Unconfirmed durable state', 502);
      room.state = state; room.version = version; room.touchedAt = now();
    } catch (error) {
      // The write may have committed even when its HTTP response was lost.
      // Never blindly replay it or keep writing forever with the old CAS.
      room.needsReconcile = true;
      try {
        const match = await reconcile(room);
        if (room.version === previous + 1 && isDeepStrictEqual(match.state, JSON.parse(JSON.stringify(state)))) return;
        broadcast(room, true); // Only a newly confirmed durable state may ACK.
      } catch { /* A later input/recovery pass must confirm state before writes. */ }
      throw error;
    }
  }
  async function settle(room) {
    if (!room.state?.pendingResult) return;
    await bridge.dispatch('admin.settleMatch', room.state.pendingResult);
    room.state = { ...room.state, pendingResult: null }; broadcast(room, true);
  }
  async function finish(room, state, reason, abandoned = false) {
    const finishedAt = now();
    const order = room.players.map((_, i) => i).sort((a, b) => state.scores[b] - state.scores[a] || a - b);
    const winner = abandoned ? null : room.players[order[0]];
    const results = order.map((i, rank) => ({ gameUserId: room.players[i], rank: abandoned ? null : rank + 1,
      score: abandoned ? 0 : state.scores[i], points: abandoned ? 0 : state.scores[i] * 10, won: room.players[i] === winner }));
    await save(room, { ...state, status: 'finished', deadline: null, finishedAt, winner, reason,
      pendingResult: { ...room.context, reason: abandoned ? 'abandoned' : 'finished', finishedAt, results } });
    broadcast(room, true); await settle(room).catch(() => {});
  }
  async function start(room) {
    const n = room.players.length;
    await save(room, { status: 'playing', scores: Array(n).fill(0), seq: Array(n).fill(0), lastActionAt: Array(n).fill(0),
      challengeIds: room.players.map(() => randomBytes(8).toString('hex')), targets: room.players.map(() => randomInt(4)),
      targetScore, cooldownMs, deadline: now() + roundMs, startedAt: now() });
  }
  function inputError(ws, error) {
    const problem = publicError(error);
    send(ws, { type: 'error', error: { ...problem, recoverable: recoverable.has(error.code) || error.status >= 500 ||
      problem.code === 'INTERNAL_ERROR' || problem.code === 'MATCH_STATE_VERSION_CONFLICT' } });
    if ([401, 403, 404].includes(error.status)) ws.close(4401, 'Session ended');
  }
  async function checkSession(ws, claims, force = false) {
    if (!force && ws.sessionCheckedAt !== undefined && now() - ws.sessionCheckedAt < sessionCacheMs) return;
    if (!ws.sessionCheckPromise) {
      ws.sessionCheckPromise = validSession(claims).then(() => { ws.sessionCheckedAt = now(); });
      ws.sessionCheckPromise.finally(() => { ws.sessionCheckPromise = null; }).catch(() => {});
    }
    await ws.sessionCheckPromise;
  }
  function scheduleInput(room) {
    if (stopping || room.inputTimer || room.draining) return;
    room.inputTimer = setTimeout(() => {
      room.inputTimer = null;
      const task = drainInputs(room); drains.add(task);
      task.catch(error => logger.warn?.({ code: 'SCORE_INPUT_DRAIN_FAILED', name: error?.name }))
        .finally(() => drains.delete(task));
    }, inputWindowMs);
    room.inputTimer.unref?.();
  }
  async function drainInputs(room) {
    if (stopping || room.draining) return;
    room.draining = true;
    const batch = room.inputQueue.splice(0, 400);
    try {
      // If the recent session cache expired, validate different sockets in
      // parallel before taking the room's durable state lock.
      const checked = await Promise.all(batch.map(async event => {
        try { await checkSession(event.ws, event.claims); return event; }
        catch (error) { inputError(event.ws, error); return null; }
      }));
      if (stopping) return;
      await serial(room.key, async () => {
        if (stopping) return;
        if (room.needsReconcile) {
          try { await reconcile(room); broadcast(room, true); }
          catch (error) { for (const event of checked) if (event) inputError(event.ws, error); return; }
        }
        const current = room.state;
        const next = current ? { ...current, scores: [...current.scores], seq: [...current.seq], lastActionAt: [...(current.lastActionAt || [])],
          challengeIds: [...(current.challengeIds || [])], targets: [...(current.targets || [])] } : null;
        const acknowledgements = new Map();
        let changed = false, winnerReached = false;
        for (const event of checked) {
          if (!event) continue;
          const { ws, claims, message, receivedAt } = event;
          if (ws.readyState !== WebSocket.OPEN) continue;
          try {
            assert(room.sockets.get(claims.sub) === ws, 'CONNECTION_REPLACED', 'Connection replaced', 409);
            const i = room.players.indexOf(claims.sub);
            assert(message.type === 'input' && Number.isSafeInteger(message.seq) && message.seq > 0 && message.input && typeof message.input === 'object',
              'INVALID_INPUT', 'Invalid action');
            assert(next, 'MATCH_NOT_STARTED', 'Waiting for roster', 409);
            if (message.seq <= next.seq[i]) { acknowledgements.set(ws, claims.sub); continue; }
            assert(next.status === 'playing' && !winnerReached, 'MATCH_FINISHED', 'Match finished', 409);
            assert(next.deadline > receivedAt, 'MATCH_FINISHED', 'Round expired', 409);
            assert(message.input.challengeId === next.challengeIds[i], 'STALE_CHALLENGE', 'Challenge already consumed', 409);
            assert(Number.isInteger(message.input.answer) && message.input.answer === next.targets[i], 'INCORRECT_ANSWER', 'Wrong target');
            assert(receivedAt - next.lastActionAt[i] >= next.cooldownMs, 'INPUT_TOO_FAST', 'Answer cooldown', 429);
            next.scores[i]++; next.seq[i] = message.seq; next.lastActionAt[i] = receivedAt;
            next.challengeIds[i] = randomBytes(8).toString('hex'); next.targets[i] = randomInt(4);
            changed = true; acknowledgements.set(ws, claims.sub);
            if (next.scores[i] >= next.targetScore) winnerReached = true;
          } catch (error) { inputError(ws, error); }
        }
        try {
          if (changed) {
            if (winnerReached) await finish(room, next, 'target_reached');
            else { await save(room, next); broadcast(room); }
          }
          // Includes duplicate sequence ACKs, but only from committed state.
          for (const [ws, user] of acknowledgements) send(ws, snapshot(room, user));
        } catch (error) { for (const ws of acknowledgements.keys()) inputError(ws, error); }
      });
    } finally {
      for (const event of batch) event.ws.pendingInputs = Math.max(0, (event.ws.pendingInputs || 1) - 1);
      room.draining = false;
      if (room.inputQueue.length) scheduleInput(room);
    }
  }
  const upgrade = (req, socket, head) => {
    let pathname; try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
    if (pathname !== path && otherPaths.includes(pathname)) return;
    if (pathname !== path || stopping || wss.clients.size >= 4096) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  };
  server.on('upgrade', upgrade);
  wss.on('connection', ws => {
    let claims, joined = false, joining = false, count = 0, bucketAt = now();
    const handshake = setTimeout(() => ws.close(4401, 'Join timeout'), 8000); handshake.unref?.();
    ws.on('error', () => {});
    ws.on('message', raw => {
      if (now() - bucketAt >= 1000) { count = 0; bucketAt = now(); }
      if (++count > 20) { ws.close(4429, 'Message rate exceeded'); return; }
      let message; try { message = JSON.parse(raw.toString()); } catch { send(ws, { type: 'error', error: { code: 'INVALID_JSON', message: 'Invalid message' } }); return; }
      if (!joined) {
        if (joining) return; joining = true;
        void (async () => {
          assert(message.type === 'join', 'JOIN_REQUIRED', 'Join ticket required', 401);
          claims = tickets.verify(message.ticket);
          assert(claims.adapterId === SCORE_RACE_ADAPTER && claims.serverId === SCORE_RACE_ADAPTER && claims.actions?.includes('join'),
            'MATCH_FORBIDDEN', 'Ticket does not permit this adapter', 403);
          await validSession(claims);
          const verifiedAt = now();
          await serial(keyFor(claims), async () => {
            const room = await getRoom(claims);
            assert(room.players.includes(claims.sub), 'MATCH_FORBIDDEN', 'Not in roster', 403);
            assert(room.state?.status !== 'finished', 'MATCH_FINISHED', 'Match finished', 409);
            await bridge.dispatch('admin.consumeMatchTicket', { ...room.context, nonce: claims.jti, gameUserId: claims.sub, expiresAt: claims.exp });
            assert(ws.readyState === WebSocket.OPEN, 'CONNECTION_CLOSED', 'Connection closed', 409);
            room.sockets.get(claims.sub)?.close(4409, 'Reconnected elsewhere'); room.sockets.set(claims.sub, ws);
            if (!room.state && room.sockets.size === room.players.length) await start(room);
            joined = true; clearTimeout(handshake); ws.arcaneClaims = claims; ws.sessionCheckedAt = verifiedAt;
            send(ws, { type: 'joined', matchRunId: claims.matchRunId, gameUserId: claims.sub });
            send(ws, snapshot(room, claims.sub)); broadcast(room);
          });
        })().catch(error => { send(ws, { type: 'error', error: publicError(error) }); ws.close(4403, 'Join denied'); });
        return;
      }
      const room = rooms.get(keyFor(claims));
      if (!room || stopping) { ws.close(4409, 'Match unavailable'); return; }
      // Per-socket and per-room bounds remain finite even during a DB outage.
      if ((ws.pendingInputs || 0) >= 4 || room.inputQueue.length >= 400) { ws.close(4429, 'Input backlog exceeded'); return; }
      ws.pendingInputs = (ws.pendingInputs || 0) + 1;
      room.inputQueue.push({ ws, claims, message, receivedAt: now() }); scheduleInput(room);
    });
    ws.on('close', () => { clearTimeout(handshake); const room = claims && rooms.get(keyFor(claims)); if (room?.sockets.get(claims.sub) === ws) room.sockets.delete(claims.sub); });
  });
  async function recoverMatches() {
    if (recovering || stopping) return recovering;
    recovering = (async () => {
      let after;
      do {
        // A 100-player final state is roughly 14–20KiB. Keep each upstream
        // response below the bridge's 1MiB bound, then page every room.
        const page = await bridge.dispatch('admin.activeMatches', { adapterId: SCORE_RACE_ADAPTER, limit: 20, ...(after ? { after } : {}) });
        for (const match of page.matches || []) await serial(keyFor(match), async () => {
          let room = rooms.get(keyFor(match));
          if (!room) room = cache(match);
          else if (room.needsReconcile || match.stateVersion > room.version) { adopt(room, match); broadcast(room, true); }
          await settle(room);
        }).catch(error => logger.warn?.({ code: 'SCORE_RECOVERY_PENDING', name: error?.name }));
        after = page.cursor;
      } while (after && !stopping);
    })().catch(error => logger.warn?.({ code: 'SCORE_RECOVERY_UNAVAILABLE', name: error?.name })).finally(() => { recovering = null; });
    return recovering;
  }
  async function retrySettlements() {
    if (retrying || stopping) return; retrying = true;
    try {
      // The cursor-based active scan includes pending results. A persistently
      // failing early room must not starve later pending rooms in a fixed page.
      await recoverMatches();
    } catch (error) { logger.warn?.({ code: 'SCORE_SETTLEMENT_UNAVAILABLE', name: error?.name }); }
    finally { retrying = false; }
  }
  async function tick() {
    for (const room of rooms.values()) await serial(room.key, async () => {
      if (room.needsReconcile) { await reconcile(room); broadcast(room, true); }
      if (!room.state && now() - room.createdAt >= joinMs) {
        const n = room.players.length;
        await finish(room, { scores: Array(n).fill(0), seq: Array(n).fill(0), targetScore }, 'join_timeout', true);
      } else if (room.state?.status === 'playing' && room.state.deadline <= now()) {
        await finish(room, room.state, 'round_timeout', room.state.scores.every(score => score === 0));
      }
      if (room.state?.status === 'finished' && !room.state.pendingResult && !room.sockets.size && now() - room.touchedAt > 60_000) rooms.delete(room.key);
    }).catch(error => logger.warn?.({ code: 'SCORE_TICK_PENDING', name: error?.name }));
  }
  async function checkSessions() {
    await Promise.allSettled([...wss.clients].map(async ws => {
      if (!ws.arcaneClaims || ws.readyState !== WebSocket.OPEN) return;
      try { await checkSession(ws, ws.arcaneClaims, true); }
      catch (error) { if ([401, 403, 404].includes(error.status) || now() - ws.sessionCheckedAt > 10_000) ws.close(4401, 'Session expired'); }
    }));
  }
  const timers = [setInterval(() => { void tick(); }, 1000), setInterval(() => { void checkSessions(); void retrySettlements(); }, 5000),
    setInterval(() => { void recoverMatches(); }, 30_000)];
  timers.forEach(timer => timer.unref?.()); void recoverMatches();
  return { rooms, recoverMatches, retrySettlements, tick, checkSessions, async close() {
    stopping = true; timers.forEach(clearInterval); server.off('upgrade', upgrade);
    for (const room of rooms.values()) { clearTimeout(room.broadcastTimer); clearTimeout(room.inputTimer); room.inputQueue.length = 0; }
    for (const ws of wss.clients) ws.terminate();
    await recovering; await Promise.allSettled([...drains]); await Promise.allSettled([...locks.values()]); await new Promise(resolve => wss.close(resolve));
  } };
}
