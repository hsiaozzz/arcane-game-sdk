import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { localPlatform, verifyNakamaArchive, assertLocalUser, localPort, localTestEnvironment } from '../tools/local-platform.mjs';

test('native launcher selects pinned Windows, macOS Intel/Apple Silicon and Linux x64/arm64 releases', () => {
  for (const [platform, arch, target, executable] of [
    ['win32', 'x64', 'windows-amd64', 'nakama.exe'],
    ['darwin', 'x64', 'darwin-amd64', 'nakama'], ['darwin', 'arm64', 'darwin-arm64', 'nakama'],
    ['linux', 'x64', 'linux-amd64', 'nakama'], ['linux', 'arm64', 'linux-arm64', 'nakama'],
  ]) {
    const release = localPlatform(platform, arch);
    assert.equal(release.target, target); assert.equal(release.executable, executable);
    assert.match(release.sha256, /^[a-f0-9]{64}$/);
    assert.equal(release.url, `https://github.com/heroiclabs/nakama/releases/download/v3.41.0/nakama-3.41.0-${target}.tar.gz`);
  }
  assert.equal(localPlatform('win32', 'x64').directory, 'nakama-3.41.0'); // preserve the existing Windows cache
  assert.throws(() => localPlatform('linux', 'ia32'), /Unsupported native/);
  assert.throws(() => localPlatform('win32', 'arm64'), /Unsupported native/);
});

test('binary archive verification fails before extraction and POSIX root is rejected without changing the OS', () => {
  const bytes = Buffer.from('test archive'), sha256 = createHash('sha256').update(bytes).digest('hex');
  verifyNakamaArchive(bytes, { sha256 });
  assert.throws(() => verifyNakamaArchive(Buffer.from('altered archive'), { sha256 }), /checksum mismatch/);
  assert.throws(() => assertLocalUser('linux', 0), /regular user/);
  assert.throws(() => assertLocalUser('darwin', 0), /regular user/);
  assert.doesNotThrow(() => assertLocalUser('darwin', 501));
  assert.doesNotThrow(() => assertLocalUser('win32', undefined));
});

test('local tests derive native/SQL credentials from a loopback-only development configuration', () => {
  const config = { ARCANE_LOCAL_DEVELOPMENT: 'true', NAKAMA_URL: 'http://127.0.0.1:7450', POSTGRES_PASSWORD: 'local:only#secret',
    NAKAMA_HTTP_KEY: 'http', NAKAMA_SERVER_KEY: 'server', ARCANE_ADMIN_KEY: 'admin', ARCANE_GATEWAY_KEY: 'gateway' };
  const env = localTestEnvironment(config);
  assert.equal(env.ARCANE_NATIVE_ENDPOINT, 'http://127.0.0.1:7450');
  assert.equal(env.ARCANE_TEST_DATABASE_URL, 'postgresql://postgres:local%3Aonly%23secret@127.0.0.1:55442/arcane');
  assert.match(localTestEnvironment({ ...config, ARCANE_PG_PORT: '55443' }).ARCANE_TEST_DATABASE_URL, /55443\/arcane$/);
  for (const override of [{ ARCANE_LOCAL_DEVELOPMENT: 'false' }, { NAKAMA_URL: 'https://production.example.com' }, { POSTGRES_PASSWORD: '' }])
    assert.throws(() => localTestEnvironment({ ...config, ...override }));
  assert.equal(localPort(undefined, 55442), 55442);
  for (const invalid of ['abc', '1.5', '0', '65535', '-1']) assert.throws(() => localPort(invalid, 55442));
});
