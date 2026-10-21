import { createHash } from 'node:crypto';

export const NAKAMA_VERSION = '3.41.0';
// Pinned digests from the official v3.41.0 GitHub release assets.
const releases = Object.freeze({
  'win32-x64': { target: 'windows-amd64', sha256: '9ff754c2750d9e8c11916f59fe6b2b07b6a6c514f8f4a9c96fc27f5df0049890' },
  'darwin-x64': { target: 'darwin-amd64', sha256: '36c7e9bd768cc358cc8c7731dc92afe1a4510e9a645aa12fd559f2b7ae400944' },
  'darwin-arm64': { target: 'darwin-arm64', sha256: '2b47bf935474df81bebc1b24a563ae579d5c93c0ec16eb673aa37480f1f0393e' },
  'linux-x64': { target: 'linux-amd64', sha256: '71aea14384b097e043917d0b1e8c3799594064acbab01853e71ea10d80624ce2' },
  'linux-arm64': { target: 'linux-arm64', sha256: '91cbd3cfb1e65e50ed61eb2d09a189ee56befcec015ca449df4a7138f533b63d' },
});

export function localPlatform(platform = process.platform, arch = process.arch) {
  const release = releases[`${platform}-${arch}`];
  if (!release) throw new Error(`Unsupported native local stack platform ${platform}/${arch}; use platform/docker-compose.yml on a supported Docker host.`);
  return { ...release, platform, arch, version: NAKAMA_VERSION,
    filename: `nakama-${NAKAMA_VERSION}-${release.target}.tar.gz`,
    executable: platform === 'win32' ? 'nakama.exe' : 'nakama',
    directory: platform === 'win32' ? `nakama-${NAKAMA_VERSION}` : `nakama-${NAKAMA_VERSION}-${release.target}`,
    url: `https://github.com/heroiclabs/nakama/releases/download/v${NAKAMA_VERSION}/nakama-${NAKAMA_VERSION}-${release.target}.tar.gz` };
}

export function verifyNakamaArchive(bytes, release) {
  if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Official Nakama binary checksum mismatch.');
}

export function assertLocalUser(platform = process.platform, uid = process.getuid?.()) {
  if (platform !== 'win32' && uid === 0) throw new Error('The native local stack must run as a regular user: PostgreSQL cannot run as root. Do not use sudo npm; use the Docker deployment for root-managed servers.');
}

export function localPort(value, fallback) {
  const port = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65534) throw new Error('Local ports must be integers from 1024 to 65534.');
  return port;
}

export function localTestEnvironment(config) {
  const nakama = new URL(config.NAKAMA_URL);
  if (config.ARCANE_LOCAL_DEVELOPMENT !== 'true' || nakama.protocol !== 'http:' || nakama.hostname !== '127.0.0.1')
    throw new Error('Local tests only accept the isolated loopback development stack.');
  for (const name of ['POSTGRES_PASSWORD', 'NAKAMA_HTTP_KEY', 'NAKAMA_SERVER_KEY', 'ARCANE_ADMIN_KEY', 'ARCANE_GATEWAY_KEY']) {
    if (typeof config[name] !== 'string' || !config[name]) throw new Error(`Missing local test configuration: ${name}`);
  }
  const port = localPort(config.ARCANE_PG_PORT, 55442);
  return {
    ARCANE_NATIVE_ENDPOINT: nakama.origin,
    ARCANE_NATIVE_HTTP_KEY: config.NAKAMA_HTTP_KEY,
    ARCANE_NATIVE_SERVER_KEY: config.NAKAMA_SERVER_KEY,
    ARCANE_NATIVE_ADMIN_KEY: config.ARCANE_ADMIN_KEY,
    ARCANE_NATIVE_GATEWAY_KEY: config.ARCANE_GATEWAY_KEY,
    ARCANE_TEST_DATABASE_URL: `postgresql://postgres:${encodeURIComponent(config.POSTGRES_PASSWORD)}@127.0.0.1:${port}/arcane`,
  };
}
