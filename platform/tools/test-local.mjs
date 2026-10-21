import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localTestEnvironment } from './local-platform.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function main() {
  if (process.argv.includes('--help')) {
    console.log('Run npm run platform:local in one terminal, then npm run platform:test:local in another. Tests use only the isolated local PostgreSQL/Nakama, including real SQL/Goja checks.');
    return;
  }
  const config = parseEnv(await readFile(path.join(root, 'platform/.local-data/platform.env'), 'utf8'));
  const testEnv = localTestEnvironment(config);
  const health = await fetch(`${testEnv.ARCANE_NATIVE_ENDPOINT}/healthcheck`, { signal: AbortSignal.timeout(3000) });
  if (!health.ok) throw new Error('Start npm run platform:local before running local tests.');
  const files = [];
  for (const directory of ['packages/game-sdk/tests', 'platform/tests']) {
    for (const filename of (await readdir(path.join(root, directory))).sort()) {
      if (filename.endsWith('.test.mjs')) files.push(path.join(directory, filename));
    }
  }
  console.log('Testing the isolated local stack with real PostgreSQL and official Nakama runtime. Credentials remain private.');
  const child = spawn(process.execPath, ['--test', ...files], { cwd: root, env: { ...process.env, ...config, ...testEnv }, stdio: 'inherit', windowsHide: true });
  const forward = signal => child.kill(signal);
  const onInt = () => forward('SIGINT'), onTerm = () => forward('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); resolve(); });
    });
  } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
}
main().catch(() => { console.error('Local test setup failed. Start npm run platform:local, use Node.js 22+, and check the private local configuration without printing it.'); process.exitCode = 1; });
