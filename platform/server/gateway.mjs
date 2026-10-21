import http from 'node:http';
import { isIP } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { assert, PlatformError, publicError } from './errors.mjs';
import { createTokenService, secretEqual } from './tokens.mjs';

export const PUBLIC_METHODS = new Set([
  'context.get', 'profile.get', 'profile.update', 'storage.read', 'storage.write', 'storage.delete', 'storage.list',
  'friends.list', 'friends.request', 'friends.accept', 'friends.remove', 'friends.block',
  'chat.channels', 'chat.history', 'chat.send', 'party.create', 'party.get', 'party.invite', 'party.accept', 'party.join', 'party.leave', 'party.ready',
  'matchmaking.join', 'matchmaking.status', 'matchmaking.cancel', 'match.get', 'match.ticket',
  'leaderboards.list', 'achievements.list', 'achievements.claim', 'economy.get', 'tournaments.list', 'tournaments.join', 'tournaments.standings',
]);
const COOKIE = 'arcane_host_session';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readJson(req, limit = 64 * 1024) {
  assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''), 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 JSON。', 415);
  assert(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 'UNSUPPORTED_MEDIA_TYPE', '请求不支持压缩编码。', 415);
  assert(!Number.isFinite(Number(req.headers['content-length'])) || Number(req.headers['content-length']) <= limit, 'PAYLOAD_TOO_LARGE', '请求内容过大。', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    assert(size <= limit, 'PAYLOAD_TOO_LARGE', '请求内容过大。', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    assert(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_ARGUMENT', '请求必须是 JSON 对象。');
    return value;
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError('INVALID_JSON', 'JSON 格式无效。');
  }
}

export function createRateLimiter({ now = Date.now, maxKeys = 10000 } = {}) {
  const buckets = new Map();
  return function limit(key, count, duration = 60_000) {
    const at = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= at) {
      if (buckets.size >= maxKeys) {
        for (const [id, item] of buckets) if (item.until <= at) buckets.delete(id);
        assert(buckets.size < maxKeys, 'RATE_LIMITED', '平台繁忙，请稍后重试。', 429);
      }
      bucket = { count: 0, until: at + duration };
      buckets.set(key, bucket);
    }
    assert(++bucket.count <= count, 'RATE_LIMITED', '操作过于频繁，请稍后重试。', 429);
  };
}

function canonicalOrigin(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.origin === value ? value : null;
  } catch { return null; }
}
const bearer = req => /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.authorization || '')?.[1];
function cookieToken(req) {
  const values = (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${COOKIE}=`));
  assert(values.length <= 1, 'INVALID_TOKEN', '登录会话无效。', 401);
  return values[0]?.slice(COOKIE.length + 1);
}

export function createGateway({ bridge, tokenSecret, adminToken, publisherKeys = {}, ticketService, adapterRegistry = {},
  allowedOrigins = [], allowedGameOrigins = [], allowLocalGameOrigin = false,
  trustedProxyIps = [],
  publicUrl = 'http://127.0.0.1:7400', secureCookies = new URL(publicUrl).protocol === 'https:',
  now = Date.now, staticHandler, logger = console } = {}) {
  assert(bridge && typeof bridge.dispatch === 'function', 'CONFIG_ERROR', 'A Nakama bridge is required.', 500);
  assert(typeof adminToken === 'string' && adminToken.length >= 32, 'CONFIG_ERROR', 'An independent administrative token is required.', 500);
  const origins = new Set(allowedOrigins.map(value => {
    assert(canonicalOrigin(value), 'CONFIG_ERROR', `Invalid trusted host origin: ${value}`, 500);
    return value;
  }));
  assert(origins.size > 0, 'CONFIG_ERROR', 'At least one trusted platform host origin is required.', 500);
  const tokens = createTokenService({ secret: tokenSecret, now });
  const limit = createRateLimiter({ now });
  const normalizeIp = ip => ip?.replace(/^::ffff:/, '') || 'unknown';
  const proxyIps = new Set(trustedProxyIps.map(normalizeIp));
  for (const ip of proxyIps) assert(isIP(ip), 'CONFIG_ERROR', 'Trusted proxies must be explicit IP addresses.', 500);
  function clientIp(req) {
    const peer = normalizeIp(req.socket.remoteAddress);
    if (!proxyIps.has(peer)) return peer;
    // The immediate trusted proxy must append the actual connecting address.
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
    return isIP(forwarded) ? normalizeIp(forwarded) : peer;
  }
  const base = new URL(publicUrl);
  const reply = (res, status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
  const setCookie = (res, token, age) => res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secureCookies ? '; Secure' : ''}`);
  function trustedHost(req) {
    const origin = req.headers.origin;
    assert(typeof origin === 'string' && origins.has(origin), 'ORIGIN_FORBIDDEN', '此页面没有平台登录权限。', 403);
    return origin;
  }
  async function activeSession(claims) {
    const sessionId = claims.hostSessionId || claims.jti;
    const session = await bridge.dispatch('admin.getSession', { sessionId });
    assert(session && !session.revoked && session.expiresAt > now() && session.platformUserId === claims.sub,
      'SESSION_EXPIRED', '登录已失效，请重新登录。', 401);
    return session;
  }
  async function hostIdentity(req) {
    const claims = tokens.verify(cookieToken(req), 'arcane-host');
    assert(uuid.test(claims.sub), 'INVALID_TOKEN', '登录身份无效。', 401);
    await activeSession(claims);
    return claims;
  }
  async function gameIdentity(req) {
    const claims = tokens.verify(bearer(req), 'arcane-game', 300_000);
    assert(ID.test(claims.gameId) && ID.test(claims.environment) && ID.test(claims.releaseId) && uuid.test(claims.sub),
      'INVALID_TOKEN', '游戏授权上下文无效。', 401);
    if (req.headers.origin) assert(req.headers.origin === claims.hostOrigin, 'ORIGIN_FORBIDDEN', '游戏凭证与页面不匹配。', 403);
    await activeSession(claims);
    return claims;
  }
  function adminIdentity(req) {
    const token = bearer(req);
    if (secretEqual(token, adminToken)) return { master: true };
    if (token) {
      const hash = createHash('sha256').update(token).digest('hex');
      for (const [publisherId, configuredHash] of Object.entries(publisherKeys))
        if (secretEqual(hash, configuredHash)) return { publisherId, master: false };
    }
    throw new PlatformError('FORBIDDEN', '缺少发布管理权限。', 403);
  }
  const runtimeContext = claims => ({ gameId: claims.gameId, environment: claims.environment, releaseId: claims.releaseId, platformUserId: claims.sub });
  async function issueMatchTicket(context, params) {
    assert(ticketService, 'MATCH_SERVER_UNAVAILABLE', '比赛服务器尚未配置。', 503);
    if (params.intent === 'entry') {
      const info = await bridge.dispatch('context.get', {}, context);
      const adapterId = info.multiplayer?.adapter;
      assert(adapterId === 'robo-rumble-authoritative-v1' && (!params.adapterId || params.adapterId === adapterId),
        'MATCH_FORBIDDEN', '此游戏不支持该入场方式。', 403);
      const adapter = adapterRegistry[adapterId];
      assert(adapter && !adapter.disabled, 'MATCH_SERVER_UNAVAILABLE', '比赛服务器尚未配置。', 503);
      const user = await bridge.dispatch('profile.get', {}, context);
      return { ...ticketService.issue(info.gameUserId, { gameId: context.gameId, environment: context.environment,
        releaseId: context.releaseId, adapterId, serverId: adapter.serverId || adapterId,
        hostSessionId: context.hostSessionId, displayName: user.displayName, actions: ['enter'] }), endpoint: adapter.endpoint,
        protocol: 'robo-rumble-v1', adapterId, gameUserId: info.gameUserId };
    }
    assert(typeof params.matchRunId === 'string' && ID.test(params.matchRunId), 'INVALID_ARGUMENT', '缺少有效比赛编号。');
    const match = await bridge.dispatch('match.get', { matchRunId: params.matchRunId }, context);
    const profile = await bridge.dispatch('context.get', {}, context);
    const adapter = adapterRegistry[match.adapterId];
    assert(adapter && !adapter.disabled && typeof adapter.endpoint === 'string', 'MATCH_SERVER_UNAVAILABLE', '该玩法的比赛服务器尚未配置。', 503);
    assert(match.status !== 'settled' && match.gameUserIds?.includes(profile.gameUserId), 'MATCH_FORBIDDEN', '你不在这场比赛的选手名单中。', 403);
    const endpoint = new URL(adapter.endpoint, base);
    assert(['ws:', 'wss:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password, 'CONFIG_ERROR', 'Invalid match endpoint.', 500);
    const signed = ticketService.issue(profile.gameUserId, { gameId: context.gameId, environment: context.environment,
      releaseId: context.releaseId, matchRunId: match.matchRunId, adapterId: match.adapterId,
      displayName: (await bridge.dispatch('profile.get', {}, context)).displayName,
      hostSessionId: context.hostSessionId,
      actions: ['join', 'input', 'resume'], serverId: adapter.serverId || match.adapterId });
    return { ...signed, endpoint: endpoint.href, protocol: adapter.protocol || 'arcane-match-v1', adapterId: match.adapterId,
      gameUserId: profile.gameUserId, matchRunId: match.matchRunId };
  }
  async function handle(req, res) {
    const requestId = randomUUID();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const parsedUrl = new URL(req.url, base);
      const pathname = parsedUrl.pathname.replace(/^\/api\/game-platform(?=\/|$)/, '') || '/';
      const origin = req.headers.origin;
      if (typeof origin === 'string' && origins.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        assert(origins.has(origin), 'ORIGIN_FORBIDDEN', '此页面没有平台访问权限。', 403);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Max-Age', '600');
        res.statusCode = 204; res.end(); return;
      }
      const ip = clientIp(req);
      if (req.method === 'GET' && pathname === '/v1/health') {
        await bridge.health();
        reply(res, 200, { status: 'ok', version: '0.1.0', backend: 'nakama-oss' }); return;
      }
      if (req.method === 'GET' && pathname === '/v1/config') {
        reply(res, 200, { enabled: true, sdkVersion: '0.1.0', protocolVersion: 1, serverTime: now() }); return;
      }
      const descriptorPath = /^\/v1\/releases\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/.exec(pathname);
      if (req.method === 'GET' && descriptorPath) {
        const [, gameId, environment, releaseId] = descriptorPath;
        const registered = await bridge.dispatch('admin.getGame', { gameId, environment, releaseId });
        assert(registered.active === true, 'RELEASE_INACTIVE', '游戏版本尚未发布完成。', 409);
        assert(registered.entryUrl, 'RELEASE_ENTRY_NOT_CONFIGURED', '游戏尚未配置发布入口。', 409);
        reply(res, 200, { gameId, environment, releaseId, buildHash: registered.buildHash, entryUrl: registered.entryUrl, manifest: registered.manifest }); return;
      }
      if (pathname.startsWith('/v1/')) {
        assert(req.method === 'POST', 'METHOD_NOT_ALLOWED', '该接口需要 POST 请求。', 405);
        const body = await readJson(req);
        if (pathname === '/v1/session') {
          trustedHost(req); limit(`auth:${ip}`, 20);
          if (!body.email && cookieToken(req)) {
            try {
              const current = await hostIdentity(req);
              reply(res, 200, { authenticated: true, user: { displayName: current.displayName }, expiresAt: current.exp }); return;
            } catch (error) { if (!(error instanceof PlatformError) || ![401, 404].includes(error.status)) throw error; }
          }
          const identity = await bridge.authenticate({ deviceId: randomUUID(), email: body.email, password: body.password, create: body.create === true });
          // An explicit account change retires all capabilities of the previous
          // cookie session, including those cached by other tabs or brokers.
          if (body.email && cookieToken(req)) {
            try {
              const previous = tokens.verify(cookieToken(req), 'arcane-host');
              await bridge.dispatch('admin.revokeSession', { sessionId: previous.jti });
            } catch (error) {
              if (!(error instanceof PlatformError) || ![401, 404].includes(error.status)) throw error;
            }
          }
          const session = tokens.issue('arcane-host', identity.id, { displayName: identity.displayName }, 7 * 86400_000);
          await bridge.dispatch('admin.createSession', { sessionId: session.claims.jti, platformUserId: identity.id, expiresAt: session.expiresAt });
          setCookie(res, session.token, 7 * 86400);
          reply(res, 200, { authenticated: true, user: { displayName: identity.displayName }, expiresAt: session.expiresAt }); return;
        }
        if (pathname === '/v1/logout') {
          trustedHost(req);
          const identity = await hostIdentity(req);
          await bridge.dispatch('admin.revokeSession', { sessionId: identity.jti });
          setCookie(res, '', 0); reply(res, 200, { loggedOut: true }); return;
        }
        if (pathname === '/v1/bootstrap') {
          const hostOrigin = trustedHost(req);
          limit(`bootstrap:${ip}`, 60);
          const host = await hostIdentity(req);
          const { gameId, environment, releaseId } = body;
          assert(ID.test(gameId || '') && ID.test(environment || '') && ID.test(releaseId || ''), 'INVALID_ARGUMENT', '需要已登记的游戏、环境和发行版本。');
          const context = { gameId, environment, releaseId, platformUserId: host.sub };
          const info = await bridge.dispatch('context.get', {}, context);
          const issued = tokens.issue('arcane-game', host.sub, { gameId, environment, releaseId,
            gameUserId: info.gameUserId, hostSessionId: host.jti, hostOrigin }, 300_000);
          reply(res, 200, { gameToken: issued.token, expiresAt: issued.expiresAt, context: info, capabilities: info.capabilities }); return;
        }
        if (pathname === '/v1/preview/register') {
          trustedHost(req); limit(`preview:${ip}`, 30);
          const host = await hostIdentity(req);
          assert(typeof body.draftId === 'string' && ID.test(body.draftId) && /^[0-9a-f]{64}$/.test(body.buildHash || ''),
            'INVALID_ARGUMENT', '草稿标识或构建摘要无效。');
          const manifest = structuredClone(body.manifest || {});
          if (manifest.multiplayer) {
            assert(adapterRegistry[manifest.multiplayer.adapter], 'ADAPTER_NOT_REGISTERED', '此预览玩法尚未配置服务器。');
            delete manifest.multiplayer.endpoint;
          }
          const gameId = `draft_${createHash('sha256').update(`${host.sub}:${body.draftId}`).digest('hex').slice(0, 40)}`;
          const releaseId = `p_${createHash('sha256').update(JSON.stringify({ buildHash: body.buildHash, manifest })).digest('hex').slice(0, 60)}`;
          const publisherId = `preview_${createHash('sha256').update(host.sub).digest('hex').slice(0, 32)}`;
          const result = await bridge.dispatch('admin.registerGame', { gameId, environment: 'preview', releaseId, publisherId,
            buildHash: body.buildHash, manifest });
          reply(res, 200, { gameId: result.gameId, environment: 'preview', releaseId: result.releaseId }); return;
        }
        if (pathname === '/v1/rpc') {
          const identity = await gameIdentity(req);
          limit(`rpc:${identity.sub}:${identity.gameId}:${identity.environment}`, 300);
          assert(typeof body.method === 'string' && PUBLIC_METHODS.has(body.method), 'METHOD_FORBIDDEN', '此方法未向游戏开放。', 403);
          const params = body.params ?? {};
          assert(params && typeof params === 'object' && !Array.isArray(params), 'INVALID_ARGUMENT', '参数必须是对象。');
          const result = body.method === 'match.ticket'
            ? await issueMatchTicket({ ...runtimeContext(identity), hostSessionId: identity.hostSessionId }, params)
            : await bridge.dispatch(body.method, params, runtimeContext(identity));
          reply(res, 200, { result }); return;
        }
        if (pathname === '/v1/admin/games/register') {
          const admin = adminIdentity(req);
          limit(`admin:${ip}`, 60);
          assert(ID.test(body.gameId || '') && ID.test(body.environment || '') && ID.test(body.releaseId || ''), 'INVALID_ARGUMENT', '游戏登记信息无效。');
          const publisherId = admin.master ? body.publisherId : admin.publisherId;
          assert(ID.test(publisherId || ''), 'INVALID_ARGUMENT', '需要有效的发布者编号。');
          if (!admin.master) {
            let existing;
            try { existing = await bridge.dispatch('admin.getGame', { gameId: body.gameId, environment: body.environment }); }
            catch (error) { if (error.status !== 404) throw error; }
            assert(!existing || existing.publisherId === publisherId, 'FORBIDDEN', '你没有此游戏的发布权限。', 403);
          }
          // A generated manifest cannot appoint an arbitrary network server.
          const manifest = structuredClone(body.manifest || {});
          if (body.entryUrl) {
            let entry;
            try { entry = new URL(body.entryUrl); } catch { throw new PlatformError('INVALID_ARGUMENT', '游戏入口地址无效。'); }
            assert(['http:', 'https:'].includes(entry.protocol) && !entry.username && !entry.password && !entry.hash,
              'INVALID_ARGUMENT', '游戏入口必须是有效的 HTTP(S) 地址。');
            const local = allowLocalGameOrigin && body.environment !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(entry.hostname);
            assert(local || (entry.protocol === 'https:' && allowedGameOrigins.includes(entry.origin) && !origins.has(entry.origin)),
              'GAME_ORIGIN_FORBIDDEN', '游戏文件必须来自已配置的独立游戏源。', 403);
          }
          if (manifest.multiplayer) {
            assert(adapterRegistry[manifest.multiplayer.adapter], 'ADAPTER_NOT_REGISTERED', '该多人玩法适配器尚未登记。');
            delete manifest.multiplayer.endpoint;
          }
          const result = await bridge.dispatch('admin.registerGame', { ...body, publisherId, manifest });
          reply(res, 200, result); return;
        }
        if (pathname === '/v1/admin/games/get') {
          const admin = adminIdentity(req);
          const result = await bridge.dispatch('admin.getGame', body);
          assert(admin.master || result.publisherId === admin.publisherId, 'FORBIDDEN', '你没有此游戏的管理权限。', 403);
          reply(res, 200, result); return;
        }
        if (pathname === '/v1/admin/games/activate') {
          const admin = adminIdentity(req);
          const registered = await bridge.dispatch('admin.getGame', { gameId: body.gameId, environment: body.environment, releaseId: body.releaseId });
          assert(admin.master || registered.publisherId === admin.publisherId, 'FORBIDDEN', '你没有此游戏的发布权限。', 403);
          assert(body.buildHash === registered.buildHash, 'RELEASE_HASH_MISMATCH', '发行版本与构建摘要不匹配。', 409);
          const result = await bridge.dispatch('admin.activateGame', { gameId: body.gameId, environment: body.environment, releaseId: body.releaseId, buildHash: body.buildHash });
          reply(res, 200, result); return;
        }
        if (['/v1/servers/matches/register', '/v1/servers/matches/settle', '/v1/servers/matches/get', '/v1/servers/matches/state', '/v1/servers/admission/consume', '/v1/servers/admission/validate'].includes(pathname)) {
          const workload = tokens.verify(bearer(req), 'arcane-workload', 86400_000);
          assert(body.gameId === workload.gameId && body.environment === workload.environment &&
            body.releaseId === workload.releaseId && (!body.adapterId || body.adapterId === workload.adapterId),
            'FORBIDDEN', '比赛服务器凭证范围不匹配。', 403);
          const action = pathname.includes('/admission/') ? 'consume' : pathname.split('/').at(-1);
          assert(workload.actions?.includes(action), 'FORBIDDEN', '比赛服务器没有此操作权限。', 403);
          if (action === 'consume') {
            const validateOnly = pathname.endsWith('/validate');
            const claims = validateOnly ? { sub: body.gameUserId, hostSessionId: body.hostSessionId } : ticketService.verify(body.ticket);
            const session = await bridge.dispatch('admin.getSession', { sessionId: claims.hostSessionId });
            assert(session && !session.revoked && session.expiresAt > now(), 'SESSION_EXPIRED', '登录已退出，请重新登录。', 401);
            const info = await bridge.dispatch('context.get', {}, { gameId: workload.gameId, environment: workload.environment,
              releaseId: workload.releaseId, platformUserId: session.platformUserId });
            assert(info.gameUserId === claims.sub, 'FORBIDDEN', '比赛身份与登录会话不匹配。', 403);
            if (validateOnly) { reply(res, 200, { valid: true }); return; }
            assert(claims.gameId === workload.gameId && claims.environment === workload.environment && claims.releaseId === workload.releaseId &&
              claims.adapterId === workload.adapterId && claims.serverId === workload.adapterId && claims.actions?.includes('enter'),
              'FORBIDDEN', '比赛入场凭证范围不匹配。', 403);
            await bridge.dispatch('admin.consumeAdmissionTicket', { gameId: workload.gameId, environment: workload.environment,
              releaseId: workload.releaseId, adapterId: workload.adapterId, nonce: claims.jti, gameUserId: claims.sub, expiresAt: claims.exp });
            reply(res, 200, { userId: claims.sub, username: claims.sub, displayName: claims.displayName, expiresAt: claims.exp,
              hostSessionId: claims.hostSessionId }); return;
          }
          const scoped = { ...body, gameId: workload.gameId, environment: workload.environment, releaseId: workload.releaseId, adapterId: workload.adapterId };
          let existingMatch;
          if (action !== 'register') {
            existingMatch = await bridge.dispatch('admin.getMatch', scoped);
            assert(existingMatch.releaseId === workload.releaseId && existingMatch.adapterId === workload.adapterId,
              'FORBIDDEN', '比赛服务器无权操作其他发行版本的比赛。', 403);
          }
          const result = action === 'get' ? existingMatch
            : action === 'state' ? await bridge.dispatch('admin.saveMatchState', scoped)
            : await bridge.dispatch(action === 'register' ? 'admin.registerMatch' : 'admin.settleMatch', scoped);
          reply(res, 200, result); return;
        }
        throw new PlatformError('NOT_FOUND', '接口不存在。', 404);
      }
      if (staticHandler && await staticHandler(req, res, parsedUrl)) return;
      throw new PlatformError('NOT_FOUND', '页面不存在。', 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (!(error instanceof PlatformError)) logger.error?.({ requestId, code: 'INTERNAL_ERROR', name: error?.name });
      if (error.status === 429) res.setHeader('Retry-After', '60');
      reply(res, error.status || 500, { error: publicError(error), requestId });
    }
  }
  const server = http.createServer((req, res) => { void handle(req, res); });
  server.headersTimeout = 15_000;
  server.requestTimeout = 15_000;
  return { server, handle, tokens, issueMatchTicket, bridge, adapterRegistry,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
