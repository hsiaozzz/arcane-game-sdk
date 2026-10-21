import { PlatformError, assert } from './errors.mjs';

const GRPC_STATUS = { 3: 400, 5: 404, 6: 409, 7: 403, 8: 429, 9: 409, 16: 401 };

export function createNakamaBridge({ url, serverKey, httpKey, gatewayKey, adminKey, fetchImpl = fetch, timeoutMs = 8000 }) {
  const base = new URL(url);
  assert(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash,
    'CONFIG_ERROR', 'NAKAMA_URL must be an HTTP(S) URL without credentials or query.', 500);
  for (const value of [serverKey, httpKey, gatewayKey, adminKey])
    assert(typeof value === 'string' && value.length >= 24, 'CONFIG_ERROR', 'Nakama and Arcane server keys are required.', 500);
  assert(gatewayKey !== adminKey, 'CONFIG_ERROR', 'Nakama administrative and gateway keys must differ.', 500);
  async function request(path, options = {}) {
    const endpoint = new URL(path, base);
    let response, value;
    try {
      response = await fetchImpl(endpoint, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      assert(text.length <= 1024 * 1024, 'UPSTREAM_RESPONSE_TOO_LARGE', '后台响应过大。', 502);
      value = text ? JSON.parse(text) : {};
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError('BACKEND_UNAVAILABLE', '游戏公共服务暂时无法连接。', 503);
    }
    if (!response.ok) {
      const grpc = value.code ?? value.error?.code;
      const message = String(value.message || value.error?.message || value.error || '后台请求未完成。').slice(0, 240);
      // Runtime messages can carry a stable symbolic prefix; never return request/secret payloads.
      const parsed = /^([A-Z][A-Z0-9_]+)(?::\s*(.*))?$/.exec(message);
      throw new PlatformError(parsed?.[1] || ({ 3: 'INVALID_ARGUMENT', 5: 'NOT_FOUND', 6: 'CONFLICT', 7: 'FORBIDDEN', 8: 'RATE_LIMITED', 9: 'PRECONDITION_FAILED', 16: 'UNAUTHENTICATED' }[grpc]) || 'BACKEND_ERROR',
        parsed?.[2] || message, GRPC_STATUS[grpc] || (response.status === 401 ? 401 : 502));
    }
    return value;
  }
  const basic = `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}`;
  return {
    async health() { await request('/healthcheck'); return true; },
    async authenticate({ deviceId, email, password, create = false }) {
      const emailMode = !!email;
      if (emailMode) assert(typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && typeof password === 'string' && password.length >= 8 && password.length <= 128,
        'INVALID_ARGUMENT', '请输入有效邮箱和至少八位密码。');
      const path = emailMode ? `/v2/account/authenticate/email?create=${create ? 'true' : 'false'}` : '/v2/account/authenticate/custom?create=true';
      const session = await request(path, { method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/json' },
        body: JSON.stringify(emailMode ? { email, password } : { id: `arcane-host:${deviceId}` }) });
      assert(typeof session.token === 'string', 'BACKEND_ERROR', '后台未返回有效登录会话。', 502);
      const account = await request('/v2/account', { headers: { Authorization: `Bearer ${session.token}` } });
      assert(/^[0-9a-f-]{36}$/i.test(account.user?.id), 'BACKEND_ERROR', '后台未返回有效账号。', 502);
      return { id: account.user.id, displayName: account.user.display_name || account.user.username, created: !!session.created };
    },
    async dispatch(method, params = {}, context = {}) {
      assert(typeof method === 'string', 'INVALID_ARGUMENT', '缺少调用方法。');
      const endpoint = new URL('/v2/rpc/arcane_dispatch', base);
      endpoint.searchParams.set('http_key', httpKey);
      endpoint.searchParams.set('unwrap', 'true');
      let result = await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gatewayKey: method.startsWith('admin.') ? adminKey : gatewayKey, context, method, params }) });
      if (typeof result?.payload === 'string') {
        try { result = JSON.parse(result.payload); } catch { throw new PlatformError('BACKEND_ERROR', '后台响应格式无效。', 502); }
      }
      return result;
    },
  };
}
