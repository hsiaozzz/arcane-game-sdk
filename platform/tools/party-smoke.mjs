import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ArcaneGame, createHttpTransport } from '../../packages/game-sdk/src/index.js';
import { createNakamaBridge } from '../server/nakama.mjs';

// Local-only live integration. No credentials, identities or invitation codes enter the report.
const root = fileURLToPath(new URL('../../', import.meta.url));
process.loadEnvFile(path.join(root, 'platform/.local-data/platform.env'));
const origin = new URL(process.env.ARCANE_PUBLIC_URL).origin, scope = { gameId: 'party-smoke-' + randomUUID(), environment: 'development', releaseId: 'large' };
assert.ok(process.env.ARCANE_LOCAL_DEVELOPMENT === 'true' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Party smoke only accepts the isolated local development stack');
const bridge = createNakamaBridge({ url: process.env.NAKAMA_URL, serverKey: process.env.NAKAMA_SERVER_KEY, httpKey: process.env.NAKAMA_HTTP_KEY, gatewayKey: process.env.ARCANE_GATEWAY_KEY, adminKey: process.env.ARCANE_ADMIN_KEY });
const results = [], hosts = [], clients = []; const startedAt = new Date().toISOString(), started = performance.now();
async function post(route, body = {}, host) {
  const response = await fetch(origin + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Origin: origin, 'Content-Type': 'application/json', ...(host?.cookie ? { Cookie: host.cookie } : {}) }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok || value.error) throw Object.assign(new Error('Request failed'), { code: value.error?.code || 'HTTP_FAILED' });
  return { value, cookie: response.headers.getSetCookie()[0]?.split(';')[0] };
}
async function client(host, releaseId = scope.releaseId) {
  const { value } = await post('/v1/bootstrap', { ...scope, releaseId }, host);
  const sdk = await ArcaneGame.connect({ transport: createHttpTransport({ gatewayUrl: origin, gameToken: value.gameToken, fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Origin: origin } }) }) });
  clients.push(sdk); return sdk;
}
async function check(name, task) {
  const at = performance.now();
  try { await task(); results.push({ name, status: 'passed', durationMs: Math.round(performance.now() - at) }); console.log('PASS ' + name); }
  catch (error) { const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'CHECK_FAILED'; results.push({ name, status: 'failed', code }); console.error('FAIL ' + name + ' (' + code + ')'); throw Object.assign(new Error('Stopped'), { code: 'SMOKE_STOPPED' }); }
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
let games, party;
try {
  await check('real Nakama registers small and 10,000-capacity releases', async () => {
    await bridge.health();
    for (const [releaseId, party] of [['default', undefined], ['large', { maxMembers: 10000 }]]) await bridge.dispatch('admin.registerGame', { ...scope, releaseId, publisherId: 'local-qa', buildHash: releaseId, manifest: { schemaVersion: '1.0', sdkVersion: '0.1', capabilities: ['profile', 'party'], ...(party ? { party } : {}) } });
    for (let i = 0; i < 3; i++) { const { cookie } = await post('/v1/session'); assert.ok(cookie); hosts.push({ cookie }); }
    games = await Promise.all(hosts.map(host => client(host)));
    const small = await client(hosts[0], 'default');
    assert.equal((await small.context.get()).party.maxMembers, 32);
    await rejects(small.party.create({ maxMembers: 33 }), 'INVALID_PARTY_MAX_MEMBERS');
    assert.equal((await games[0].context.get()).party.maxMembers, 10000);
  });
  await check('SDK creates a 10,000-capacity code party and admits a non-friend', async () => {
    party = (await games[0].party.create({ maxMembers: 10000, joinPolicy: 'code' })).party;
    assert.equal(party.maxMembers, 10000); assert.ok(/^[a-f0-9]{64}$/.test(party.joinCode));
    await rejects(games[2].party.join({ partyId: party.partyId, joinCode: '0'.repeat(64) }), 'PARTY_JOIN_DENIED');
    const joined = (await games[1].party.join({ partyId: party.partyId, joinCode: party.joinCode })).party;
    assert.equal(joined.memberCount, 2); assert.equal('joinCode' in joined, false);
  });
  await check('bounded live member pages preserve self, readiness and leader code privacy', async () => {
    const ids = new Set(); let cursor;
    do {
      const page = (await games[0].party.get({ partyId: party.partyId, limit: 1, ...(cursor ? { cursor } : {}) })).party;
      assert.equal(page.members.length, 1); assert.ok(page.self); assert.ok(typeof page.joinCode === 'string'); ids.add(page.members[0].gameUserId); cursor = page.cursor;
    } while (cursor);
    assert.equal(ids.size, 2);
    const ready = (await games[1].party.ready({ partyId: party.partyId, ready: true })).party;
    assert.equal(ready.readyCount, 1); assert.equal(ready.self.ready, true); assert.equal('joinCode' in ready, false);
    await rejects(games[2].party.get({ partyId: party.partyId }), 'PARTY_ACCESS_DENIED');
  });
  await check('concurrent non-friend code joins respect a two-player party capacity', async () => {
    await games[0].party.leave({ partyId: party.partyId }); await games[1].party.leave({ partyId: party.partyId });
    const small = (await games[0].party.create({ maxMembers: 2, joinPolicy: 'code' })).party;
    const joins = await Promise.allSettled(games.slice(1).map(game => game.party.join({ partyId: small.partyId, joinCode: small.joinCode })));
    assert.equal(joins.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(joins.filter(result => result.status === 'rejected' && result.reason.code === 'PARTY_FULL').length, 1);
    assert.equal((await games[0].party.get()).party.memberCount, 2);
  });
} catch (error) {
  if (error.code !== 'SMOKE_STOPPED') { results.push({ name: 'setup', status: 'failed', code: 'SETUP_FAILED' }); console.error('FAIL setup'); }
} finally {
  for (const sdk of clients) sdk.close();
  await Promise.allSettled(hosts.map(host => post('/v1/logout', {}, host)));
  const report = { startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), backend: 'real-nakama-postgresql-via-sdk-http', note: '10,000 is configured capacity; this smoke joins two actual users, not 10,000 concurrent players.', passed: results.filter(result => result.status === 'passed').length, failed: results.filter(result => result.status === 'failed').length, checks: results };
  await mkdir(path.join(root, 'platform/.local-data'), { recursive: true }); await writeFile(path.join(root, 'platform/.local-data/party-smoke-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Party smoke: ${report.passed} passed, ${report.failed} failed.`);
  if (report.failed) process.exitCode = 1;
}
