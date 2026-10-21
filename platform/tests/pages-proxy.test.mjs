import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../../functions/api/game-platform/[[path]].js';

test('Pages proxy is disabled without a secure backend and refuses admin and cross-origin writes', async () => {
  const invoke = (path, env = {}, origin = 'https://studio.test') => onRequest({
    request: new Request('https://studio.test/api/game-platform/' + path, { method: 'POST', headers: { Origin: origin } }), env, params: { path: path.split('/') } });
  assert.equal((await invoke('v1/rpc')).status, 503);
  assert.equal((await invoke('v1/rpc', { ARCANE_PLATFORM_ORIGIN: 'http://private.test' })).status, 503);
  assert.equal((await invoke('v1/admin/games/register', { ARCANE_PLATFORM_ORIGIN: 'https://private.test' })).status, 404);
  assert.equal((await invoke('v1/servers/admission/consume', { ARCANE_PLATFORM_ORIGIN: 'https://private.test' })).status, 404);
  assert.equal((await invoke('v1/rpc', { ARCANE_PLATFORM_ORIGIN: 'https://private.test' }, 'https://game-content.test')).status, 403);
});

test('Pages forwards only scoped browser headers and preserves HttpOnly session cookies without following redirects', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let called;
  globalThis.fetch = async (url, options) => {
    called = { url: String(url), ...options };
    return new Response('{}', { status: 200, headers: { 'Set-Cookie': 'arcane_host_session=opaque; HttpOnly; Secure; SameSite=Lax; Path=/' } });
  };
  const request = new Request('https://studio.test/api/game-platform/v1/rpc', { method: 'POST', headers: {
    Origin: 'https://studio.test', 'Content-Type': 'application/json', Authorization: 'Bearer scoped', Cookie: 'arcane_host_session=opaque',
    'X-Forwarded-For': 'spoofed', 'X-Admin-Key': 'never-forward' }, body: '{"method":"profile.get"}' });
  const result = await onRequest({ request, env: { ARCANE_PLATFORM_ORIGIN: 'https://private.test' }, params: { path: ['v1', 'rpc'] } });
  assert.equal(called.url, 'https://private.test/v1/rpc'); assert.equal(called.redirect, 'manual');
  assert.equal(called.headers.get('X-Admin-Key'), null); assert.equal(called.headers.get('X-Forwarded-For'), null);
  assert.equal(called.headers.get('Authorization'), 'Bearer scoped'); assert.equal(called.headers.get('Origin'), 'https://studio.test');
  assert.match(result.headers.get('Set-Cookie'), /HttpOnly/); assert.equal(result.headers.get('Cache-Control'), 'no-store');
});
