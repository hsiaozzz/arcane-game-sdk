import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, generateKeyPairSync } from 'node:crypto';
import { createGateway } from '../server/gateway.mjs';
import { createMatchTicketService, createTokenService } from '../server/tokens.mjs';
import { PlatformError } from '../server/errors.mjs';

const SECRET = 'test-secret-not-for-production-'.repeat(2), ADMIN = 'test-master-not-for-production-'.repeat(2);
const ORIGIN = 'http://trusted.arcane.test';
function fakeBridge() {
  const sessions = new Map(), releases = new Map(), calls = [];
  const bridge = { calls, sessions, releases, health: async () => true,
    authenticate: async () => ({ id: randomUUID(), displayName: '测试玩家' }),
    async dispatch(method, params, context = {}) {
      calls.push({ method, params, context });
      if (method === 'admin.createSession') { const session = { ...params, revoked: false }; sessions.set(params.sessionId, session); return session; }
      if (method === 'admin.getSession') { const value = sessions.get(params.sessionId); if (!value) throw new PlatformError('SESSION_EXPIRED', 'expired', 401); return value; }
      if (method === 'admin.revokeSession') { sessions.get(params.sessionId).revoked = true; return {}; }
      if (method === 'admin.registerGame') { const value = structuredClone(params); releases.set(`${params.gameId}/${params.environment}/${params.releaseId}`, value); return value; }
      if (method === 'admin.getGame') {
        const value = params.releaseId ? releases.get(`${params.gameId}/${params.environment}/${params.releaseId}`)
          : [...releases.values()].find(r => r.gameId === params.gameId && r.environment === params.environment);
        if (!value) throw new PlatformError('NOT_FOUND', 'absent', 404); return value;
      }
      if (method === 'admin.getMatch') return { matchRunId: params.matchRunId, releaseId: 'other-release', adapterId: 'turn-based-v1', gameUserIds: [] };
      if (method === 'context.get') return { ...context, platformUserId: undefined, gameUserId: `gusr_${createHash('md5').update(context.gameId + context.platformUserId).digest('hex')}`, capabilities: ['profile', 'storage'] };
      if (method === 'profile.get') return { gameUserId: 'gusr_scoped', displayName: '玩家', version: 0 };
      return { context, params };
    } };
  return bridge;
}
async function setup(t, overrides = {}) {
  const bridge = fakeBridge();
  const app = createGateway({ bridge, tokenSecret: SECRET, adminToken: ADMIN, allowedOrigins: [ORIGIN],
    publicUrl: ORIGIN, adapterRegistry: { 'turn-based-v1': { endpoint: 'ws://localhost:7400/v1/matches' } }, ...overrides });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function post(path, body = {}, { token, cookie, origin = ORIGIN } = {}) {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(origin !== undefined && origin !== null ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  async function login() {
    const session = await post('/v1/session');
    assert.equal(session.status, 200); assert.match(session.cookie, /HttpOnly/); assert.match(session.cookie, /SameSite=Lax/);
    const cookie = session.cookie.split(';')[0];
    const auth = await post('/v1/bootstrap', { gameId: 'game-a', environment: 'development', releaseId: 'r1' }, { cookie });
    assert.equal(auth.status, 200);
    return { cookie, token: auth.body.gameToken, context: auth.body.context };
  }
  return { app, bridge, base, post, login };
}

test('opaque/untrusted frames cannot establish platform identity, even with a valid cookie', async t => {
  const { post, login } = await setup(t);
  const denied = await post('/v1/session', {}, { origin: 'null' });
  assert.equal(denied.status, 403);
  const user = await login();
  assert.equal((await post('/v1/bootstrap', { gameId: 'game-a', environment: 'development', releaseId: 'r1' }, { cookie: user.cookie, origin: 'https://evil.test' })).status, 403);
});
test('game calls derive all context from signed scope and reject administrative escape', async t => {
  const { post, login, bridge } = await setup(t), user = await login();
  const allowed = await post('/v1/rpc', { method: 'storage.read', params: { key: 'save', gameId: 'victim', platformUserId: 'admin' }, context: { gameId: 'victim' } }, user);
  assert.equal(allowed.status, 200);
  const dispatched = bridge.calls.at(-1);
  assert.equal(dispatched.context.gameId, 'game-a');
  assert.equal(dispatched.context.environment, 'development');
  assert.equal((await post('/v1/rpc', { method: 'admin.settleMatch', params: {} }, user)).status, 403);
  assert.equal((await post('/v1/rpc', { method: 'profile.get' }, { ...user, origin: 'https://other.test' })).status, 403);
});
test('logout revokes issued game capabilities, including across independent browser requests', async t => {
  const { post, login } = await setup(t), user = await login();
  assert.equal((await post('/v1/rpc', { method: 'profile.get' }, user)).status, 200);
  assert.equal((await post('/v1/logout', {}, user)).status, 200);
  assert.equal((await post('/v1/rpc', { method: 'profile.get' }, user)).status, 401);
});

test('explicit account login revokes the previous cookie session and cached game tokens', async t => {
  const { post, login } = await setup(t), old = await login();
  const switched = await post('/v1/session', { email: 'new@example.test', password: 'test-password' }, old);
  assert.equal(switched.status, 200); assert.notEqual(switched.cookie, old.cookie);
  assert.equal((await post('/v1/rpc', { method: 'profile.get' }, old)).status, 401);
});

test('a pending release descriptor cannot launch a staged game', async t => {
  const { bridge, base } = await setup(t);
  const data = { gameId: 'staged', environment: 'production', releaseId: 'r1', entryUrl: 'https://games.test/game.html', manifest: {}, active: false };
  bridge.releases.set('staged/production/r1', data);
  const pending = await fetch(`${base}/v1/releases/staged/production/r1`);
  assert.equal(pending.status, 409); assert.equal((await pending.json()).error.code, 'RELEASE_INACTIVE');
  data.active = true;
  assert.equal((await fetch(`${base}/v1/releases/staged/production/r1`)).status, 200);
});

test('forwarded addresses affect rate limiting only for explicit trusted proxy peers', async t => {
  for (const trusted of [false, true]) {
    const { base } = await setup(t, { trustedProxyIps: trusted ? ['127.0.0.1'] : [] });
    let response;
    for (let i = 1; i <= 21; i++) {
      response = await fetch(`${base}/v1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN,
        'X-Forwarded-For': `10.10.1.99, 192.0.2.${i}` }, body: '{}' });
      await response.arrayBuffer();
    }
    assert.equal(response.status, trusted ? 200 : 429);
  }
});
test('untrusted origins and generated manifests cannot appoint servers or publish releases', async t => {
  const { post, login } = await setup(t), user = await login();
  const registration = { gameId: 'game-a', environment: 'production', releaseId: 'r1', publisherId: 'owner', buildHash: 'hash',
    entryUrl: `${ORIGIN}/generated.html`, manifest: { multiplayer: { adapter: 'turn-based-v1', endpoint: 'wss://evil.test' } } };
  assert.equal((await post('/v1/admin/games/register', registration, user)).status, 403);
  const denied = await post('/v1/admin/games/register', registration, { token: ADMIN });
  assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'GAME_ORIGIN_FORBIDDEN');
});
test('publisher keys are bound to owners; request bodies cannot nominate a different publisher', async t => {
  const publisherToken = 'publisher-token-'.repeat(4);
  const { post, bridge } = await setup(t, { publisherKeys: { 'publisher-one': createHash('sha256').update(publisherToken).digest('hex') } });
  const data = { gameId: 'game-a', environment: 'development', releaseId: 'r1', publisherId: 'victim-owner', buildHash: 'hash', manifest: {} };
  assert.equal((await post('/v1/admin/games/register', data, { token: publisherToken })).status, 200);
  assert.equal(bridge.calls.at(-1).params.publisherId, 'publisher-one');
  bridge.releases.get('game-a/development/r1').publisherId = 'victim-owner';
  assert.equal((await post('/v1/admin/games/register', { ...data, releaseId: 'r2' }, { token: publisherToken })).status, 403);
});
test('workload release scope is mandatory and checked against the registered match', async t => {
  const { app, post, bridge } = await setup(t);
  const token = app.tokens.issue('arcane-workload', 'server-a', { gameId: 'game-a', environment: 'development', releaseId: 'r1',
    adapterId: 'turn-based-v1', actions: ['register', 'get', 'state', 'settle'] }, 3600_000).token;
  const body = { gameId: 'game-a', environment: 'development', matchRunId: 'known-other-release-match', adapterId: 'turn-based-v1' };
  assert.equal((await post('/v1/servers/matches/settle', body, { token, origin: null })).status, 403);
  const denied = await post('/v1/servers/matches/state', { ...body, releaseId: 'r1', expectedVersion: 0, state: {} }, { token, origin: null });
  assert.equal(denied.status, 403);
  assert.equal(bridge.calls.some(call => call.method === 'admin.saveMatchState'), false);
});

test('unused signed admission and active-server validation are revoked with their host session', async t => {
  const pair = generateKeyPairSync('ed25519'), tickets = createMatchTicketService({ privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const { app, post, login, bridge } = await setup(t, { ticketService: tickets }), user = await login();
  const hostSessionId = app.tokens.verify(user.cookie.split('=')[1], 'arcane-host').jti;
  const scope = { gameId: 'game-a', environment: 'development', releaseId: 'r1', adapterId: 'robo-rumble-authoritative-v1' };
  const token = app.tokens.issue('arcane-workload', 'robo-a', { ...scope, actions: ['consume'] }, 3600000).token;
  const ticket = tickets.issue(user.context.gameUserId, { ...scope, serverId: scope.adapterId, hostSessionId, actions: ['enter'] }).ticket;
  const valid = await post('/v1/servers/admission/validate', { ...scope, hostSessionId, gameUserId: user.context.gameUserId }, { token, origin: null });
  assert.equal(valid.status, 200); assert.deepEqual(valid.body, { valid: true });
  const stranger = await post('/v1/servers/admission/validate', { ...scope, hostSessionId, gameUserId: 'someone-else' }, { token, origin: null });
  assert.equal(stranger.status, 403);
  await post('/v1/logout', {}, user);
  const denied = await post('/v1/servers/admission/consume', { ...scope, ticket }, { token, origin: null });
  assert.equal(denied.status, 401);
  assert.equal(bridge.calls.some(call => call.method === 'admin.consumeAdmissionTicket'), false);
  assert.equal((await post('/v1/servers/admission/validate', { ...scope, hostSessionId, gameUserId: user.context.gameUserId }, { token, origin: null })).status, 401);
});
test('preview identifiers are derived from verified host identity, keeping different drafts isolated', async t => {
  const { post, login } = await setup(t), user = await login();
  const first = await post('/v1/preview/register', { draftId: 'draft-a', buildHash: 'a'.repeat(64), manifest: { capabilities: ['storage'] } }, user);
  const second = await post('/v1/preview/register', { draftId: 'draft-b', buildHash: 'a'.repeat(64), manifest: { capabilities: ['storage'] } }, user);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.notEqual(first.body.gameId, second.body.gameId);
  assert.equal(first.body.environment, 'preview');
  const otherUser = await login();
  const other = await post('/v1/preview/register', { draftId: 'draft-a', buildHash: 'a'.repeat(64), manifest: { capabilities: ['storage'] } }, otherUser);
  assert.notEqual(other.body.gameId, first.body.gameId);
});

test('token purposes, signatures, lifetimes and public-key-only match verification are enforced', () => {
  let clock = 100_000;
  const tokens = createTokenService({ secret: SECRET, now: () => clock });
  const game = tokens.issue('arcane-game', randomUUID(), { gameId: 'game-a' }, 1000);
  assert.equal(tokens.verify(game.token, 'arcane-game').gameId, 'game-a');
  assert.throws(() => tokens.verify(game.token, 'arcane-host'), /用途/);
  const pieces = game.token.split('.'); pieces[1] = Buffer.from(JSON.stringify({ sub: 'evil' })).toString('base64url');
  assert.throws(() => tokens.verify(pieces.join('.'), 'arcane-game'), /签名/);
  clock += 1001; assert.throws(() => tokens.verify(game.token, 'arcane-game'), /过期/);
  const pair = generateKeyPairSync('ed25519');
  const signer = createMatchTicketService({ privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), now: () => clock });
  const verifier = createMatchTicketService({ publicKey: signer.publicKey, now: () => clock });
  const ticket = signer.issue('gusr_player', { matchRunId: 'match-a' });
  assert.equal(verifier.verify(ticket.ticket).matchRunId, 'match-a');
  assert.throws(() => verifier.issue('gusr_player', {}), /cannot sign/);
});
