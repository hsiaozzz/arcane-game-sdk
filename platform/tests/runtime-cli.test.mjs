import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTokenService } from '../server/tokens.mjs';
import { main as register } from '../tools/register-game.mjs';
import { main as workload } from '../tools/create-workload-token.mjs';

const secret = 'operator-signing-secret-'.padEnd(64, 'x');
const publisher = 'publisher-control-credential-'.padEnd(64, 'y');
const root = fileURLToPath(new URL('../../', import.meta.url));
const scope = ['--game-id', 'demo', '--environment', 'production', '--release-id', 'release-1'];
const manifest = { schemaVersion: '1.0', sdkVersion: '0.1', capabilities: ['profile'] };
const outputCapture = () => { const lines = []; return { lines, output: line => lines.push(line) }; };
const fixture = async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'arcane-cli-'));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('arcane-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const processTool = async (name, args, env = {}) => {
  const child = spawn(process.execPath, [path.join(root, 'platform/tools', name), ...args], { windowsHide: true, env: { ...process.env, ARCANE_TOKEN_SECRET: '', ARCANE_PUBLISH_TOKEN: '', ARCANE_ADMIN_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const [code] = await once(child, 'close'); return { code, stdout, stderr };
};

test('production tools expose help without credentials and reject unknown CLI fields', async () => {
  for (const name of ['register-game.mjs', 'create-workload-token.mjs']) {
    const result = await processTool(name, ['--help']); assert.equal(result.code, 0); assert.match(result.stdout, /Usage:/);
    const bad = await processTool(name, ['--token', publisher]); assert.equal(bad.code, 1); assert.equal((bad.stdout + bad.stderr).includes(publisher), false);
  }
});

test('registration sends a publisher-scoped staged release, activation verifies exact hash context', async t => {
  const directory = await fixture(t), file = path.join(directory, 'game.json'); await writeFile(file, JSON.stringify(manifest));
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({ route: req.url, authorization: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...body, active: req.url.endsWith('/activate') || body.activate, token: 'server-secret-must-not-be-printed' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ARCANE_PUBLISH_TOKEN: publisher, ARCANE_PUBLIC_URL: origin };
  const staged = await processTool('register-game.mjs', [...scope, '--manifest', file, '--build-hash', 'hash-1'], env);
  assert.equal(staged.code, 0, staged.stderr); assert.equal(JSON.parse(staged.stdout).active, false);
  assert.equal(received[0].route, '/v1/admin/games/register'); assert.equal(received[0].authorization, `Bearer ${publisher}`);
  assert.equal(received[0].body.activate, false); assert.deepEqual(received[0].body.manifest, manifest); assert.equal(received[0].body.publisherId, undefined);
  assert.equal(staged.stdout.includes(publisher), false); assert.equal(staged.stdout.includes('server-secret'), false);
  const active = await processTool('register-game.mjs', ['activate', ...scope, '--build-hash', 'hash-1'], env);
  assert.equal(active.code, 0, active.stderr); assert.equal(JSON.parse(active.stdout).active, true);
  assert.equal(received[1].route, '/v1/admin/games/activate'); assert.deepEqual(received[1].body, { gameId: 'demo', environment: 'production', releaseId: 'release-1', buildHash: 'hash-1' });
});

test('registration fails before transport for untrusted origins, owner spoofing and malformed manifest', async t => {
  const directory = await fixture(t), file = path.join(directory, 'game.json'); await writeFile(file, JSON.stringify(manifest));
  const args = [...scope, '--manifest', file, '--build-hash', 'hash-1'];
  let calls = 0; const fetchImpl = () => { calls++; throw new Error('unexpected transport'); };
  const env = { ARCANE_PUBLISH_TOKEN: publisher, ARCANE_PUBLIC_URL: 'https://platform.example' };
  await assert.rejects(register([...args, '--gateway', 'http://remote.example'], { env, fetchImpl }), /HTTPS origin/);
  await assert.rejects(register([...args, '--gateway', 'https://user:pass@platform.example'], { env, fetchImpl }), /HTTPS origin/);
  await assert.rejects(register([...args, '--publisher-id', 'another-owner'], { env, fetchImpl }), /registered owner/);
  await assert.rejects(register(args, { env: { ARCANE_ADMIN_TOKEN: publisher, ARCANE_PUBLIC_URL: env.ARCANE_PUBLIC_URL }, fetchImpl }), /publisher-id/);
  await writeFile(file, 'broken-private-value'); await assert.rejects(register(args, { env, fetchImpl }), /valid JSON/);
  await writeFile(file, JSON.stringify({ ...manifest, padding: 'x'.repeat(32768) })); await assert.rejects(register(args, { env, fetchImpl }), /32 KiB/);
  assert.equal(calls, 0);
});

test('registration rejects redirects, gateway failures and mismatched release responses without printing secrets', async t => {
  const directory = await fixture(t), file = path.join(directory, 'game.json'); await writeFile(file, JSON.stringify(manifest));
  const args = [...scope, '--manifest', file, '--build-hash', 'hash-1'];
  const env = { ARCANE_PUBLISH_TOKEN: publisher, ARCANE_PUBLIC_URL: 'https://platform.example' };
  await assert.rejects(register(args, { env, fetchImpl: async (_url, init) => {
    assert.equal(init.redirect, 'error'); return new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: publisher } }), { status: 403 });
  } }), error => error.message.includes('FORBIDDEN') && !error.message.includes(publisher));
  await assert.rejects(register(args, { env, fetchImpl: async () => new Response(JSON.stringify({ gameId: 'another', environment: 'production', releaseId: 'release-1', buildHash: 'hash-1', active: false })) }), /does not match/);
});

test('workload CLI creates a bounded gateway-compatible token in a new owner-only file and never prints it', async t => {
  const directory = await fixture(t), target = path.join(directory, 'workload.json');
  const result = await processTool('create-workload-token.mjs', [...scope, '--adapter-id', 'robo-rumble-authoritative-v1', '--subject', 'robo-server-1', '--actions', 'register,get,state,settle,consume', '--ttl-seconds', '600', '--output', target], { ARCANE_TOKEN_SECRET: secret });
  assert.equal(result.code, 0, result.stderr);
  const saved = JSON.parse(await readFile(target, 'utf8'));
  const claims = createTokenService({ secret }).verify(saved.token, 'arcane-workload', 86400_000);
  assert.equal(claims.gameId, 'demo'); assert.equal(claims.environment, 'production'); assert.equal(claims.releaseId, 'release-1'); assert.equal(claims.adapterId, 'robo-rumble-authoritative-v1'); assert.equal(claims.sub, 'robo-server-1');
  assert.equal(claims.exp - claims.iat, 600000); assert.deepEqual(claims.actions, ['register', 'get', 'state', 'settle', 'consume']);
  assert.equal(saved.expiresAt, claims.exp); assert.equal(result.stdout.includes(saved.token), false); assert.equal((result.stdout + result.stderr).includes(secret), false);
  if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
  const original = await readFile(target, 'utf8');
  const retry = await processTool('create-workload-token.mjs', [...scope, '--adapter-id', 'robo-rumble-authoritative-v1', '--subject', 'robo-server-1', '--output', target], { ARCANE_TOKEN_SECRET: secret });
  assert.equal(retry.code, 1); assert.match(retry.stderr, /already exists/); assert.equal(await readFile(target, 'utf8'), original);
});

test('workload validation rejects unscoped, wildcard, excessive lifetime and unknown privileges before creating files', async t => {
  const directory = await fixture(t), target = path.join(directory, 'no-token.json');
  const base = [...scope, '--adapter-id', 'turn-based-v1', '--subject', 'turn-server-1', '--output', target];
  const env = { ARCANE_TOKEN_SECRET: secret }, capture = outputCapture();
  for (const [extra, pattern] of [[['--ttl-seconds', '86401'], /ttl-seconds/], [['--ttl-seconds', '1.5'], /ttl-seconds/], [['--actions', '*'], /actions/], [['--actions', 'settle,admin'], /actions/], [['--actions', 'get,get'], /actions/], [['--game-id', '*'], /valid|Invalid arguments/]])
    await assert.rejects(workload([...base, ...extra], { env, ...capture }), pattern);
  await assert.rejects(workload(base.filter((_, i) => i !== 4 && i !== 5), { env, ...capture }), /release-id/);
  await assert.rejects(workload(base, { env: {}, ...capture }), /ARCANE_TOKEN_SECRET/);
  await assert.rejects(readFile(target), error => error.code === 'ENOENT'); assert.equal(capture.lines.length, 0);
});
