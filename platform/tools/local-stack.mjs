import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access, unlink, chmod } from 'node:fs/promises';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { buildSdk } from './build-sdk.mjs';
import { createPlatform } from '../server/main.mjs';
import { localPlatform, verifyNakamaArchive, assertLocalUser, localPort } from './local-platform.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const local = path.join(root, 'platform/.local-data');
const exists = file => access(file).then(() => true, () => false);
const children = new Set();
let database, app, stopping = false, stopPromise;
const secretFile = path.join(local, 'secrets.json'), lockFile = path.join(local, 'stack.lock');
let ownsLock = false;
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });
    child.once('error', error => { children.delete(child); reject(error); });
    child.once('exit', code => { children.delete(child); code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${code}); inspect local configuration and port availability.`)); });
  });
}
async function stop(code = 0) {
  process.exitCode = Math.max(process.exitCode || 0, code);
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = (async () => {
  await app?.close().catch(() => {});
  await Promise.allSettled([...children].map(child => new Promise(resolve => { child.once('exit', resolve); child.kill(); setTimeout(resolve, 3000).unref(); })));
  await database?.stop().catch(() => {});
  if (ownsLock) await unlink(lockFile).catch(() => {});
  })();
  return stopPromise;
}
async function main() {
  const release = localPlatform();
  assertLocalUser();
  await mkdir(local, { recursive: true });
  if (await exists(lockFile)) {
    const prior = Number(await readFile(lockFile, 'utf8'));
    let alive = false;
    try { process.kill(prior, 0); alive = true; } catch {}
    if (alive) throw new Error('The Arcane local stack is already running. Stop that process before starting another.');
    await unlink(lockFile);
  }
  await writeFile(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 }); ownsLock = true;
  let secrets;
  if (await exists(secretFile)) secrets = JSON.parse(await readFile(secretFile, 'utf8'));
  else {
    secrets = Object.fromEntries(['POSTGRES_PASSWORD', 'NAKAMA_SERVER_KEY', 'NAKAMA_HTTP_KEY', 'NAKAMA_SESSION_KEY', 'NAKAMA_REFRESH_KEY',
      'NAKAMA_CONSOLE_PASSWORD', 'ARCANE_GATEWAY_KEY', 'ARCANE_ADMIN_KEY', 'ARCANE_ADMIN_TOKEN', 'ARCANE_TOKEN_SECRET'].map(key => [key, randomBytes(32).toString('hex')]));
    const keys = generateKeyPairSync('ed25519');
    secrets.ARCANE_MATCH_PRIVATE_KEY = Buffer.from(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    secrets.ARCANE_MATCH_PUBLIC_KEY = Buffer.from(keys.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
    await writeFile(secretFile, JSON.stringify(secrets, null, 2), { flag: 'wx', mode: 0o600 });
  }
  await buildSdk();
  await run(process.execPath, ['platform/nakama/build-runtime.mjs']);
  const bin = path.join(local, release.directory), executable = path.join(bin, release.executable);
  if (!await exists(executable)) {
    console.log(`Downloading official Nakama ${release.version} (${release.target}); SHA-256 verification required.`);
    const response = await fetch(release.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error('Official Nakama binary download failed.');
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyNakamaArchive(bytes, release);
    const archive = path.join(local, release.filename); await writeFile(archive, bytes);
    await mkdir(bin, { recursive: true }); await run('tar', ['-xf', archive, '-C', bin]);
  }
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  const pgPort = localPort(process.env.ARCANE_PG_PORT, 55442), apiPort = localPort(process.env.ARCANE_NAKAMA_PORT, 7450);
  const gatewayPort = localPort(process.env.ARCANE_PORT, 7400);
  if (new Set([pgPort, apiPort, apiPort + 1, gatewayPort]).size !== 4) throw new Error('Local PostgreSQL, Nakama API/console and Gateway ports must be distinct.');
  database = new EmbeddedPostgres({ databaseDir: path.join(local, 'postgres'), user: 'postgres', password: secrets.POSTGRES_PASSWORD,
    port: pgPort, persistent: true, authMethod: 'scram-sha-256', initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {} });
  if (!await exists(path.join(local, 'postgres/PG_VERSION'))) await database.initialise();
  await database.start();
  const client = database.getPgClient(); await client.connect();
  try { if (!(await client.query("SELECT 1 FROM pg_database WHERE datname='arcane'")).rows.length)
    await client.query("CREATE DATABASE arcane WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'"); }
  finally { await client.end(); }
  const address = `postgres:${secrets.POSTGRES_PASSWORD}@127.0.0.1:${pgPort}/arcane`;
  await run(executable, ['migrate', 'up', '--database.address', address]);
  const config = { name: 'arcane-local', data_dir: path.join(local, 'nakama-data'), logger: { level: 'WARN' },
    database: { address: [address] }, runtime: { path: path.join(root, 'platform/nakama/runtime'), js_entrypoint: 'index.js', http_key: secrets.NAKAMA_HTTP_KEY,
      env: [`ARCANE_GATEWAY_KEY=${secrets.ARCANE_GATEWAY_KEY}`, `ARCANE_ADMIN_KEY=${secrets.ARCANE_ADMIN_KEY}`,
        'ARCANE_ADAPTER_IDS=turn-based-v1,score-race-v1'] },
    socket: { address: '127.0.0.1', port: apiPort, server_key: secrets.NAKAMA_SERVER_KEY, max_message_size_bytes: 262144 },
    console: { address: '127.0.0.1', port: apiPort + 1, username: 'admin', password: secrets.NAKAMA_CONSOLE_PASSWORD },
    session: { encryption_key: secrets.NAKAMA_SESSION_KEY, refresh_encryption_key: secrets.NAKAMA_REFRESH_KEY, token_expiry_sec: 7200, refresh_token_expiry_sec: 604800 } };
  const configFile = path.join(local, 'nakama.yml'); await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const nakama = spawn(executable, ['--config', configFile], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(nakama);
  nakama.once('error', () => { children.delete(nakama); console.error('Nakama could not start. Check native dependencies and executable permissions; see the platform README for your operating system.'); void stop(1); });
  nakama.once('exit', code => { children.delete(nakama); if (!stopping) { console.error(`Nakama stopped (${code}).`); void stop(1); } });
  // Do not stream server log text containing connection addresses or secrets into chat.
  let diagnostic = '';
  for (const stream of [nakama.stdout, nakama.stderr]) stream.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-32_000); });
  const internalUrl = `http://127.0.0.1:${apiPort}`;
  let ready = false;
  for (let i = 0; i < 100 && !stopping; i++) {
    try { ready = (await fetch(`${internalUrl}/healthcheck`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) {
    for (const secret of Object.values(secrets)) diagnostic = diagnostic.replaceAll(secret, '[REDACTED]');
    await writeFile(path.join(local, 'startup-diagnostics.log'), diagnostic, { mode: 0o600 });
    throw new Error('Nakama did not start; sanitized diagnostics saved in platform/.local-data/startup-diagnostics.log.');
  }
  const publicUrl = `http://127.0.0.1:${gatewayPort}`;
  const env = { ...secrets, NAKAMA_URL: internalUrl, ARCANE_PUBLIC_URL: publicUrl, ARCANE_PORT: String(gatewayPort), ARCANE_PG_PORT: String(pgPort),
    ARCANE_LOCAL_DEVELOPMENT: 'true',
    ARCANE_ALLOWED_ORIGINS: ['127.0.0.1', 'localhost'].flatMap(host => [...new Set([gatewayPort, 5201, 5202, 5173])].map(port => `http://${host}:${port}`)).join(',') };
  await writeFile(path.join(local, 'platform.env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  app = await createPlatform({ env });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(gatewayPort, '127.0.0.1', resolve); });
  const common = { schemaVersion: '1.0', sdkVersion: '0.1', capabilities: ['profile', 'storage', 'friends', 'chat', 'party', 'matchmaking', 'match', 'leaderboards', 'achievements', 'economy', 'tournaments'],
    leaderboards: { points: { sort: 'descending', period: 'all_time', metric: 'points', operator: 'sum', writePolicy: 'verified_match_result' },
      weekly: { sort: 'descending', period: 'weekly', metric: 'points', operator: 'sum', writePolicy: 'verified_match_result' },
      wins: { sort: 'descending', period: 'all_time', metric: 'wins', operator: 'sum', writePolicy: 'verified_match_result' } },
    achievements: { first_win: { name: '第一场胜利', event: 'match.won', target: 1, reward: { coins: 100 } }, first_match: { name: '迈出第一步', event: 'match.played', target: 1, reward: { coins: 20 } } } };
  const seeds = [
    { gameId: 'arcane-take-away', environment: 'development', entryUrl: `${publicUrl}/examples/take-away/game.html`,
      manifest: { ...common, multiplayer: { adapter: 'turn-based-v1', minPlayers: 2, maxPlayers: 2 } } },
    { gameId: 'arcane-score-race', environment: 'development', entryUrl: `${publicUrl}/examples/score-race/game.html`,
      manifest: { ...common, party: { maxMembers: 10000 }, multiplayer: { adapter: 'score-race-v1', minPlayers: 2, maxPlayers: 100 } } },
  ];
  for (const seed of seeds) await app.bridge.dispatch('admin.registerGame', { ...seed, releaseId: 'dev', publisherId: 'arcane-local', buildHash: 'arcane-sdk-0.1.0-development' });
  console.log(`\nArcane SDK + Nakama OSS + PostgreSQL ready.\nTurn-based: ${publicUrl}/play/arcane-take-away\nScore race (2–100): ${publicUrl}/play/arcane-score-race\nHealth: ${publicUrl}/v1/health\nLocal credentials and database stay in platform/.local-data. Ctrl+C stops this stack.`);
}
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
main().catch(async error => { console.error(error.message); await stop(1); });
