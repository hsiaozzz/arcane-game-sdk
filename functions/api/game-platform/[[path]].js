// Same-origin browser gateway. Nakama and administrative keys never reach Pages.
export async function onRequest({ request, env, params }) {
  const path = Array.isArray(params.path) ? params.path.join('/') : String(params.path || '');
  if (!/^v1\/(?:session|logout|bootstrap|rpc|preview\/register|config|health)$/.test(path))
    return Response.json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } }, { status: 404 });
  let origin;
  try {
    origin = new URL(env.ARCANE_PLATFORM_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) throw new Error();
  } catch {
    return Response.json({ error: { code: 'PLATFORM_DISABLED', message: '游戏公共服务尚未配置。' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const current = new URL(request.url);
  if (request.method === 'POST' && request.headers.get('Origin') !== current.origin)
    return Response.json({ error: { code: 'ORIGIN_FORBIDDEN', message: '页面没有平台访问权限。' } }, { status: 403 });
  const headers = new Headers();
  for (const name of ['Content-Type', 'Authorization', 'Cookie', 'Origin']) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  let upstream;
  try {
    upstream = await fetch(new URL(`/${path}`, origin), { method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual', signal: AbortSignal.timeout(12_000) });
  } catch { return Response.json({ error: { code: 'BACKEND_UNAVAILABLE', message: '公共服务暂时无法连接。' } }, { status: 503 }); }
  // No credential-bearing redirects to another upstream are followed.
  const responseHeaders = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (upstream.headers.has('Set-Cookie')) responseHeaders.set('Set-Cookie', upstream.headers.get('Set-Cookie'));
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
