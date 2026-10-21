import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function buildSdk() {
  const output = path.join(root, 'public/runtime/arcane-game-sdk/v1/index.js');
  await build({ entryPoints: [path.join(root, 'packages/game-sdk/src/index.js')], outfile: output,
    bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true, legalComments: 'inline',
    banner: { js: '/*! @arcane/game-sdk 0.1.0 — MIT License */' } });
  console.log('Built @arcane/game-sdk browser runtime.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSdk();
