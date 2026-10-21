import { createSocialOverlay } from './social-overlay.js';

// Cookie-writing requests must finish in order, including requests made by
// separate game mounts. Web Locks extends the same gate to other host tabs.
const accountQueues = new Map();
function accountGateKey(base) {
  try { return `arcane-account:${new URL(base, globalThis.window?.location?.href || globalThis.window?.location?.origin || 'http://arcane.invalid').origin}`; }
  catch { return `arcane-account:${base}`; }
}
function accountGate(key, operation, { locks, signal } = {}) {
  const previous = accountQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => {
    signal?.throwIfAborted?.();
    return typeof locks?.request === 'function'
      ? locks.request(key, { mode: 'exclusive', ...(signal ? { signal } : {}) }, operation)
      : operation();
  });
  const tracked = next.finally(() => { if (accountQueues.get(key) === tracked) accountQueues.delete(key); });
  accountQueues.set(key, tracked);
  return tracked;
}

const PUBLIC_METHODS = new Set([
  'context.get', 'profile.get', 'profile.update', 'storage.read', 'storage.write', 'storage.delete', 'storage.list',
  'friends.list', 'friends.request', 'friends.accept', 'friends.remove', 'friends.block',
  'chat.channels', 'chat.history', 'chat.send', 'party.create', 'party.get', 'party.invite', 'party.accept', 'party.join', 'party.leave', 'party.ready',
  'matchmaking.join', 'matchmaking.status', 'matchmaking.cancel', 'match.get', 'match.ticket',
  'leaderboards.list', 'achievements.list', 'achievements.claim', 'economy.get',
  'tournaments.list', 'tournaments.join', 'tournaments.standings', 'social.open'
]);

function errorEnvelope(error) {
  return { code: error?.code || 'SERVICE_UNAVAILABLE', message: error?.message || '平台服务暂不可用', ...(error?.status ? { status: error.status } : {}) };
}

export function createGatewayClient({ gatewayUrl, gameId = 'arcane-preview', environment = 'preview', releaseId = 'dev', previewDraft, fetchImpl = globalThis.fetch, signal, onIdentityChange, accountStorage, accountLocks = globalThis.navigator?.locks } = {}) {
  const base = String(gatewayUrl || '').replace(/\/+$/, '');
  const gateKey = accountGateKey(base);
  let storage = accountStorage;
  if (storage === undefined) { try { storage = globalThis.window?.sessionStorage; } catch { storage = null; } }
  const logoutKey = `arcane:account:signed-out:${base}`;
  let authorization = null;
  let booting = null;
  let registeredContext = null;
  let sessionInfo = null;
  let authVersion = 0;
  let signedOut = false;
  try { signedOut = storage?.getItem(logoutKey) === '1'; } catch { /* Host storage may be disabled by browser preferences. */ }
  let changingIdentity = false;
  function setSignedOut(value) {
    signedOut = value;
    try { if (value) storage?.setItem(logoutKey, '1'); else storage?.removeItem(logoutKey); } catch { /* The in-memory lock still applies. */ }
  }
  const authError = () => Object.assign(new Error('请先在账号页登录或选择游客模式'), { code: 'AUTH_REQUIRED' });
  const assertCurrent = (version) => { if (version !== authVersion || signedOut) throw authError(); };
  function invalidate(reason) {
    ++authVersion;
    authorization = null;
    booting = null;
    registeredContext = null;
    sessionInfo = null;
    onIdentityChange?.({ authenticated: false, reason });
  }
  const accountState = () => ({ authenticated: !signedOut && !!sessionInfo?.authenticated, ...(sessionInfo?.user?.displayName ? { displayName: sessionInfo.user.displayName } : {}) });
  async function changeAccount(operation) {
    if (changingIdentity) throw Object.assign(new Error('正在切换账号，请稍候'), { code: 'AUTH_BUSY' });
    changingIdentity = true;
    try { return await operation(); } finally { changingIdentity = false; }
  }
  async function post(path, body, token) {
    if (!base) throw Object.assign(new Error('平台尚未配置服务地址'), { code: 'PLATFORM_DISABLED' });
    const execute = async () => {
    const response = await fetchImpl(`${base}${path}`, {
      method: 'POST', credentials: 'include', signal,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw Object.assign(new Error(data.error?.message || `平台请求失败 (${response.status})`), { code: data.error?.code || 'GATEWAY_ERROR', status: response.status });
    return data;
    };
    return path === '/v1/session' || path === '/v1/logout'
      ? accountGate(gateKey, execute, { locks: accountLocks, signal })
      : execute();
  }
  async function bootstrap() {
    if (signedOut) throw authError();
    if (authorization && authorization.expiresAt > Date.now() + 5000) return authorization;
    if (!booting) {
      const version = authVersion;
      const operation = (async () => {
      const identity = await post('/v1/session', {});
      assertCurrent(version);
      sessionInfo = identity;
      if (previewDraft && !registeredContext) {
        const registered = await post('/v1/preview/register', previewDraft);
        assertCurrent(version);
        if (!registered.gameId || registered.environment !== 'preview' || !registered.releaseId) throw Object.assign(new Error('平台没有返回有效的预览上下文'), { code: 'INVALID_PREVIEW_CONTEXT' });
        registeredContext = { gameId: registered.gameId, environment: registered.environment, releaseId: registered.releaseId };
      }
      const result = await post('/v1/bootstrap', registeredContext || { gameId, environment, releaseId });
      assertCurrent(version);
      if (!result.gameToken) throw new Error('平台没有返回游戏会话');
      authorization = { ...result, authVersion: version };
      return authorization;
      })().finally(() => { if (booting === operation) booting = null; });
      booting = operation;
    }
    return booting;
  }
  return {
    bootstrap,
    // This object is only passed to the trusted overlay. It is deliberately
    // absent from the child MessagePort method allowlist and SDK context.
    account: {
      async status() { if (!signedOut) await bootstrap(); return accountState(); },
      async login({ email, password, create = false } = {}) {
        return changeAccount(async () => {
        if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) throw new Error('请输入邮箱和密码');
        setSignedOut(true); invalidate('login');
        const version = authVersion;
        const identity = await post('/v1/session', { email: email.trim(), password, create: create === true });
        if (version !== authVersion) throw authError();
        sessionInfo = identity; setSignedOut(false);
        await bootstrap();
        const state = accountState(); onIdentityChange?.(state); return state;
        });
      },
      async logout() {
        return changeAccount(async () => {
        setSignedOut(true); invalidate('logout');
        try { await post('/v1/logout', {}); }
        catch (error) { if (error.status !== 401) throw error; }
        return accountState();
        });
      },
      async guest() {
        return changeAccount(async () => {
        setSignedOut(true); invalidate('guest');
        const version = authVersion;
        try { await post('/v1/logout', {}); }
        catch (error) { if (error.status !== 401) throw error; }
        if (version !== authVersion) throw authError();
        setSignedOut(false);
        await bootstrap();
        const state = accountState(); onIdentityChange?.(state); return state;
        });
      }
    },
    async request(method, params = {}) {
      if (!PUBLIC_METHODS.has(method) || method === 'social.open') throw Object.assign(new Error('不支持的平台操作'), { code: 'METHOD_NOT_ALLOWED' });
      const session = await bootstrap();
      let response;
      try { response = await post('/v1/rpc', { method, params }, session.gameToken); }
      catch (error) {
        if (error.status === 401 && session.authVersion === authVersion) { setSignedOut(true); invalidate('session-expired'); }
        throw error;
      }
      assertCurrent(session.authVersion);
      return response.result;
    }
  };
}

export function createGameHostBroker({ iframe, gatewayUrl = '', manifest = {}, gameId = 'arcane-preview', environment = 'preview', releaseId = 'dev', previewDraft, parentWindow = globalThis.window, fetchImpl, onState, overlayFactory = createSocialOverlay } = {}) {
  if (!iframe || !parentWindow?.crypto?.getRandomValues) throw new Error('Trusted iframe and secure randomness are required');
  const bytes = parentWindow.crypto.getRandomValues(new Uint8Array(24));
  const channelId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const controller = new AbortController();
  const capabilities = new Set(manifest.capabilities || []);
  const ports = new Set();
  let closed = false;
  let overlay;
  let suspendedFrame;
  function suspendGame() {
    if (suspendedFrame || closed) return;
    if (typeof iframe.srcdoc === 'string' && (iframe.hasAttribute?.('srcdoc') || iframe.srcdoc)) {
      suspendedFrame = { type: 'srcdoc', value: iframe.srcdoc };
      iframe.removeAttribute?.('srcdoc');
      if (!iframe.removeAttribute) iframe.srcdoc = '';
    } else if (typeof iframe.src === 'string' && iframe.src && iframe.src !== 'about:blank') {
      suspendedFrame = { type: 'src', value: iframe.src };
    }
    if (suspendedFrame) iframe.src = 'about:blank';
  }
  function resumeGame() {
    if (!suspendedFrame || closed) return;
    const source = suspendedFrame; suspendedFrame = null;
    iframe[source.type] = source.value;
  }
  const client = createGatewayClient({ gatewayUrl, gameId, environment, releaseId, previewDraft, fetchImpl, signal: controller.signal, accountLocks: parentWindow.navigator?.locks, onIdentityChange(state) {
    if (closed) return;
    for (const port of ports) { port.postMessage({ type: 'close', error: { code: 'SESSION_CHANGED', message: '账号已切换，请重新连接平台' } }); port.close(); }
    ports.clear();
    if (state.authenticated) resumeGame(); else suspendGame();
    onState?.({ status: state.authenticated ? 'connected' : 'signed-out', ...(state.authenticated ? {} : { message: state.reason === 'login' || state.reason === 'guest' ? '正在切换账号…' : '已退出账号，请登录或选择游客继续游戏' }) });
  } });
  const config = { protocol: 'arcane-game-sdk', version: 1, hostOrigin: parentWindow.location.origin, channelId, capabilities: [...capabilities] };
  const emit = (event, data) => { if (!closed) for (const port of ports) port.postMessage({ type: 'event', event, data }); };
  async function request(method, params = {}) {
    if (closed) throw Object.assign(new Error('游戏预览已关闭'), { code: 'HOST_CLOSED' });
    if (!PUBLIC_METHODS.has(method)) throw Object.assign(new Error('不支持的平台操作'), { code: 'METHOD_NOT_ALLOWED' });
    const capability = method.split('.')[0];
    if (!['context', 'social'].includes(capability) && !capabilities.has(capability) && !(capability === 'match' && capabilities.has('matchmaking'))) throw Object.assign(new Error('游戏未声明这项平台能力'), { code: 'CAPABILITY_DISABLED' });
    if (method === 'social.open') {
      overlay ||= overlayFactory({ client: { request }, account: client.account, manifest, document: parentWindow.document, onClose: () => emit('social.closed', {}) });
      overlay.open(params);
      return { opened: true };
    }
    const result = await client.request(method, params);
    onState?.({ status: 'connected' });
    if (/^(?:friends|party|chat)\./.test(method) && !/\.(?:get|list|history|channels)$/.test(method)) emit(`${capability}.updated`, result);
    return result;
  }
  function onConnect(event) {
    const data = event.data;
    if (closed || event.source !== iframe.contentWindow || !data || data.type !== 'arcane:connect' || data.protocolVersion !== 1 || data.channelId !== channelId || event.ports?.length !== 1) return;
    // An opaque iframe legitimately reports origin "null"; only the exact
    // WindowProxy plus the per-mount nonce authorizes this transferred port.
    const port = event.ports[0];
    if (ports.size >= 8) { port.postMessage({ type: 'close', error: { code: 'RATE_LIMITED', message: 'Too many platform connections' } }); port.close(); return; }
    ports.add(port);
    const pending = new Set();
    let budgetStart = Date.now();
    let count = 0;
    port.onmessage = async ({ data: message }) => {
      if (closed || message?.type !== 'request' || typeof message.id !== 'string' || message.id.length > 100 || pending.has(message.id)) return;
      const id = message.id;
      try {
        if (Date.now() - budgetStart > 10000) { budgetStart = Date.now(); count = 0; }
        if (++count > 120 || pending.size >= 24 || JSON.stringify(message).length > 131072) throw Object.assign(new Error('平台请求过于频繁或内容过大'), { code: 'RATE_LIMITED' });
        pending.add(id);
        const result = await request(message.method, message.params || {});
        if (!closed) port.postMessage({ type: 'response', id, result });
      } catch (error) {
        if (!closed) { port.postMessage({ type: 'response', id, error: errorEnvelope(error) }); onState?.({ status: 'unavailable', message: error.message }); }
      } finally { pending.delete(id); }
    };
    port.start?.();
    port.postMessage({ type: 'ready', protocolVersion: 1 });
  }
  parentWindow.addEventListener('message', onConnect);
  return {
    config, request, emit,
    close() {
      if (closed) return;
      closed = true;
      controller.abort();
      parentWindow.removeEventListener('message', onConnect);
      for (const port of ports) { port.postMessage({ type: 'close', error: { code: 'HOST_CLOSED', message: 'Game host closed' } }); port.close(); }
      ports.clear();
      overlay?.destroy();
    }
  };
}
