import { WebSocketServer, WebSocket } from 'ws';
import { isDeepStrictEqual } from 'node:util';
import { assert, publicError } from './errors.mjs';

export const TURN_ADAPTER = 'turn-based-v1';
const MAX_BACKLOG = 64 * 1024;
const send = (ws, value) => { if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_BACKLOG) ws.send(JSON.stringify(value)); };

/** A platform-maintained authoritative template. It never evaluates generated code. */
export function attachTurnMatchServer({ server, bridge, tickets, now = Date.now, path = '/v1/matches', otherPaths = [], turnMs = 60_000, joinMs = 120_000, logger = console }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const rooms = new Map(), consumed = new Map(), locks = new Map();
  let stopping = false, retrying = false, recovery;
  const keyFor = value => `${value.gameId}/${value.environment}/${value.matchRunId}`;
  function serial(key, operation) {
    const previous = locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    locks.set(key, next);
    return next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
  }
  function runtimeParams(claims) { return { gameId: claims.gameId, environment: claims.environment, matchRunId: claims.matchRunId, adapterId: TURN_ADAPTER }; }
  async function validSession(claims) {
    assert(typeof claims.hostSessionId === 'string', 'SESSION_EXPIRED', '比赛凭证缺少登录会话。', 401);
    const session = await bridge.dispatch('admin.getSession', { sessionId: claims.hostSessionId });
    assert(session && !session.revoked && session.expiresAt > now(), 'SESSION_EXPIRED', '登录已退出，请重新登录。', 401);
  }
  function cacheMatch(match) {
    assert(match.adapterId === TURN_ADAPTER && match.gameUserIds?.length === 2,
      'MATCH_FORBIDDEN', '比赛与玩法版本不匹配。', 403);
    const room = { key: keyFor(match), context: { ...runtimeParams(match), releaseId: match.releaseId }, players: match.gameUserIds,
      state: match.state || null, version: match.stateVersion || 0, sockets: new Map(),
      createdAt: match.createdAt, touchedAt: now() };
    rooms.set(room.key, room);
    return room;
  }
  async function getRoom(claims) {
    const key = keyFor(claims);
    let room = rooms.get(key);
    if (room) {
      if (room.needsReconcile) { await reconcile(room); broadcast(room); }
      return room;
    }
    const match = await bridge.dispatch('admin.getMatch', runtimeParams(claims));
    assert(match.adapterId === TURN_ADAPTER && match.releaseId === claims.releaseId && match.gameUserIds?.length === 2,
      'MATCH_FORBIDDEN', '比赛与玩法版本不匹配。', 403);
    return cacheMatch(match);
  }
  function snapshot(room, userId) {
    if (!room.state) return { type: 'state', state: { status: 'waiting', players: room.players }, ack: 0, serverTime: now() };
    const { seqByPlayer, pendingResult, ...publicState } = room.state;
    return { type: 'state', state: { ...publicState, players: room.players, settlement: pendingResult ? 'pending' : 'confirmed' },
      ack: seqByPlayer?.[userId] || 0, serverTime: now() };
  }
  function broadcast(room) {
    for (const [user, ws] of room.sockets) send(ws, snapshot(room, user));
  }
  async function reconcile(room, match) {
    const persisted = match || await bridge.dispatch('admin.getMatch', room.context);
    assert(keyFor(persisted) === room.key && persisted.adapterId === TURN_ADAPTER && persisted.releaseId === room.context.releaseId &&
      isDeepStrictEqual(persisted.gameUserIds, room.players) && Number.isSafeInteger(persisted.stateVersion) && persisted.stateVersion >= room.version,
    'BACKEND_ERROR', '服务器状态核对未确认。', 502);
    room.state = persisted.state || null;
    room.version = persisted.stateVersion;
    if (persisted.status === 'settled' && room.state?.pendingResult) room.state = { ...room.state, pendingResult: null };
    room.needsReconcile = false;
    room.touchedAt = now();
    return persisted;
  }
  async function save(room, next) {
    const expectedVersion = room.version;
    let version;
    try {
      const saved = await bridge.dispatch('admin.saveMatchState', { ...room.context, expectedVersion, state: next });
      version = saved.stateVersion ?? saved.version;
      assert(Number.isSafeInteger(version) && version === expectedVersion + 1, 'BACKEND_ERROR', '服务器状态保存未确认。', 502);
    } catch (error) {
      // A timeout can happen after COMMIT. Read the durable row before deciding
      // whether the input failed, rather than leaving this room on a stale CAS.
      room.needsReconcile = true;
      try {
        const persisted = await reconcile(room);
        if (persisted.stateVersion === expectedVersion + 1 && isDeepStrictEqual(persisted.state, next)) return;
        broadcast(room);
      } catch { /* Keep needsReconcile set if the durable row is unavailable. */ }
      throw error;
    }
    room.state = next;
    room.version = version;
    room.needsReconcile = false;
    room.touchedAt = now();
  }
  async function settle(room) {
    if (!room.state?.pendingResult) return;
    const result = room.state.pendingResult;
    await bridge.dispatch('admin.settleMatch', result);
    room.state = { ...room.state, pendingResult: null };
    // Settled runtime rows retain the frozen final state; no further gameplay write is required.
    broadcast(room);
  }
  function resultFor(room, winner, finishedAt) {
    return { ...room.context, reason: winner ? 'finished' : 'abandoned', finishedAt,
      results: room.players.map(gameUserId => ({ gameUserId, rank: winner ? (gameUserId === winner ? 1 : 2) : null,
        score: winner ? (gameUserId === winner ? 100 : 25) : 0,
        points: winner ? (gameUserId === winner ? 100 : 25) : 0, won: gameUserId === winner })) };
  }
  async function finish(room, state, winner, reason) {
    const finishedAt = now();
    const next = { ...state, status: 'finished', winner, reason, finishedAt, deadline: null,
      pendingResult: resultFor(room, winner, finishedAt) };
    await save(room, next);
    broadcast(room);
    try { await settle(room); } catch { /* Durable pendingResult is retried on startup and the background timer. */ }
  }
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
    if (pathname !== path && otherPaths.includes(pathname)) return;
    if (pathname !== path || stopping || wss.clients.size >= 1024) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    let claims, joined = false, joining = false, messageCount = 0, bucketAt = now();
    const handshakeTimer = setTimeout(() => ws.close(4401, 'Join timeout'), 8000);
    handshakeTimer.unref?.();
    ws.on('error', () => {});
    ws.on('message', raw => {
      if (now() - bucketAt > 1000) { messageCount = 0; bucketAt = now(); }
      if (++messageCount > 30) { ws.close(4429, 'Message rate exceeded'); return; }
      let value;
      try { value = JSON.parse(raw.toString()); } catch { send(ws, { type: 'error', error: { code: 'INVALID_JSON', message: '消息格式无效。' } }); return; }
      if (!joined) {
        if (joining) return;
        joining = true;
        void (async () => {
          assert(value.type === 'join', 'JOIN_REQUIRED', '请先提交比赛入场凭证。', 401);
          claims = tickets.verify(value.ticket);
          await validSession(claims);
          assert(claims.adapterId === TURN_ADAPTER && claims.serverId === TURN_ADAPTER && claims.actions?.includes('join'),
            'MATCH_FORBIDDEN', '此凭证不允许加入该比赛。', 403);
          await serial(keyFor(claims), async () => {
            assert(!consumed.has(claims.jti), 'TICKET_REPLAYED', '入场凭证已使用，请重新领取。', 401);
            const room = await getRoom(claims);
            assert(room.players.includes(claims.sub), 'MATCH_FORBIDDEN', '你不是这场比赛的选手。', 403);
            assert(ws.readyState === WebSocket.OPEN, 'CONNECTION_CLOSED', '比赛连接已关闭。', 409);
            // One-use is persisted by Nakama so replay is rejected across gateway restart/replicas too.
            await bridge.dispatch('admin.consumeMatchTicket', { ...room.context, nonce: claims.jti, gameUserId: claims.sub, expiresAt: claims.exp });
            consumed.set(claims.jti, claims.exp);
            assert(ws.readyState === WebSocket.OPEN, 'CONNECTION_CLOSED', '比赛连接已关闭。', 409);
            room.sockets.get(claims.sub)?.close(4409, 'Reconnected elsewhere');
            room.sockets.set(claims.sub, ws);
            if (!room.state && room.sockets.size === 2) await save(room, { status: 'playing', stones: 21, maxTake: 3, turn: room.players[0],
              move: 0, seqByPlayer: {}, deadline: now() + turnMs, startedAt: now() });
            joined = true; clearTimeout(handshakeTimer);
            ws.arcaneClaims = claims; ws.sessionCheckedAt = now();
            send(ws, { type: 'joined', matchRunId: claims.matchRunId, gameUserId: claims.sub });
            broadcast(room);
            if (room.state?.pendingResult) await settle(room).catch(() => {});
          });
        })().catch(error => { send(ws, { type: 'error', error: publicError(error) }); ws.close(4403, 'Join denied'); });
        return;
      }
      void serial(keyFor(claims), async () => {
        const room = await getRoom(claims);
        assert(room.sockets.get(claims.sub) === ws, 'CONNECTION_REPLACED', '该比赛已在另一连接恢复。', 409);
        await validSession(claims);
        if (value.type === 'ping') { send(ws, { type: 'pong', serverTime: now() }); return; }
        assert(value.type === 'input' && value.input && typeof value.input === 'object', 'INVALID_INPUT', '未知比赛消息。');
        assert(Number.isSafeInteger(value.seq) && value.seq > 0, 'INVALID_INPUT', '输入序号无效。');
        assert(room.state, 'MATCH_NOT_STARTED', '正在等待另一位选手入场。', 409);
        if (value.seq <= (room.state.seqByPlayer?.[claims.sub] || 0)) { send(ws, snapshot(room, claims.sub)); return; }
        assert(room.state.status === 'playing', 'MATCH_FINISHED', '比赛已经结束。', 409);
        assert(room.state.turn === claims.sub, 'NOT_YOUR_TURN', '还没轮到你。', 409);
        assert(room.state.deadline > now(), 'TURN_EXPIRED', '本回合已经超时。', 409);
        const take = value.input.take;
        assert(Number.isInteger(take) && take >= 1 && take <= room.state.maxTake && take <= room.state.stones,
          'INVALID_MOVE', '每回合可取一至三颗星石。');
        const next = { ...room.state, stones: room.state.stones - take, move: room.state.move + 1,
          seqByPlayer: { ...room.state.seqByPlayer, [claims.sub]: value.seq }, lastMove: { player: claims.sub, take } };
        if (next.stones === 0) await finish(room, next, claims.sub, 'last_stone');
        else { next.turn = room.players.find(id => id !== claims.sub); next.deadline = now() + turnMs; await save(room, next); broadcast(room); }
      }).catch(error => send(ws, { type: 'error', error: { ...publicError(error), recoverable: ['NOT_YOUR_TURN', 'INVALID_MOVE', 'TURN_EXPIRED', 'MATCH_FINISHED', 'MATCH_NOT_STARTED', 'INVALID_INPUT'].includes(error.code) } }));
    });
    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      if (claims) {
        const room = rooms.get(keyFor(claims));
        if (room?.sockets.get(claims.sub) === ws) room.sockets.delete(claims.sub);
      }
    });
  });
  async function retrySettlements() {
    if (retrying || stopping) return;
    retrying = true;
    try {
      const pending = await bridge.dispatch('admin.pendingMatches', { adapterId: TURN_ADAPTER, limit: 100 });
      for (const match of pending.matches || []) {
        const value = match.state?.pendingResult;
        if (value) await serial(keyFor(value), async () => {
          await bridge.dispatch('admin.settleMatch', value);
          const room = rooms.get(keyFor(value));
          if (room?.state?.pendingResult) { room.state = { ...room.state, pendingResult: null }; broadcast(room); }
        }).catch(() => {});
      }
    } catch (error) { logger.warn?.({ code: 'SETTLEMENT_RETRY_UNAVAILABLE', name: error?.name }); }
    finally { retrying = false; }
  }
  async function recoverMatches() {
    if (recovery) return recovery;
    if (stopping) return;
    recovery = (async () => {
      let after;
      do {
        const page = await bridge.dispatch('admin.activeMatches', { adapterId: TURN_ADAPTER, limit: 100, ...(after ? { after } : {}) });
        for (const match of page.matches || []) {
          if (stopping) return;
          await serial(keyFor(match), async () => {
            const room = rooms.get(keyFor(match)) || cacheMatch(match);
            if (room.needsReconcile) { await reconcile(room, match); broadcast(room); }
            if (room.state?.pendingResult) await settle(room);
          }).catch(error => logger.warn?.({ code: 'MATCH_RECOVERY_PENDING', name: error?.name }));
        }
        after = page.cursor;
      } while (after && !stopping);
    })().catch(error => logger.warn?.({ code: 'MATCH_RECOVERY_UNAVAILABLE', name: error?.name }))
      .finally(() => { recovery = null; });
    return recovery;
  }
  async function tick() {
    const at = now();
    for (const [nonce, expiry] of consumed) if (expiry <= at) consumed.delete(nonce);
    const tasks = [];
    for (const [key, room] of rooms) {
      if (!room.state && at - room.createdAt >= joinMs) {
        tasks.push(serial(key, async () => {
          if (!room.state) await finish(room, { stones: 21, seqByPlayer: {} }, null, 'join_timeout');
        }).catch(error => logger.warn?.({ code: 'ABANDON_PERSIST_FAILED', name: error?.name })));
      } else if (room.state?.status === 'playing' && room.state.deadline <= at) {
        tasks.push(serial(key, async () => {
          if (room.state.status !== 'playing' || room.state.deadline > now()) return;
          const winner = room.players.find(id => id !== room.state.turn);
          await finish(room, room.state, winner, 'turn_timeout');
        }).catch(error => logger.warn?.({ code: 'TURN_TIMEOUT_PERSIST_FAILED', name: error?.name })));
      }
      if (room.state?.status === 'finished' && room.sockets.size === 0 && at - room.touchedAt > 60_000) rooms.delete(key);
    }
    await Promise.allSettled(tasks);
  }
  const timer = setInterval(() => { void tick(); }, 1000);
  async function checkSessions() {
    await Promise.allSettled([...wss.clients].map(async ws => {
      if (!ws.arcaneClaims || ws.sessionChecking || ws.readyState !== WebSocket.OPEN) return;
      ws.sessionChecking = true;
      try { await validSession(ws.arcaneClaims); ws.sessionCheckedAt = now(); }
      catch (error) {
        if ([401, 403, 404].includes(error.status) || now() - ws.sessionCheckedAt > 10_000) ws.close(4401, 'Session expired');
      } finally { ws.sessionChecking = false; }
    }));
  }
  const sessionTimer = setInterval(() => { void checkSessions(); }, 5000);
  const retryTimer = setInterval(() => { void retrySettlements(); }, 5000);
  const recoveryTimer = setInterval(() => { void recoverMatches(); }, 30_000);
  timer.unref?.(); retryTimer.unref?.(); recoveryTimer.unref?.(); sessionTimer.unref?.();
  void recoverMatches();
  return { rooms, retrySettlements, recoverMatches, tick, checkSessions,
    async close() {
      stopping = true; clearInterval(timer); clearInterval(retryTimer); clearInterval(recoveryTimer); clearInterval(sessionTimer);
      for (const ws of wss.clients) ws.terminate();
      await recovery;
      await Promise.allSettled([...locks.values()]);
      await new Promise(resolve => wss.close(resolve));
    } };
}
