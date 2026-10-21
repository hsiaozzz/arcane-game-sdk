import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSdk } from '../platform/tools/build-sdk.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = path.join(root, 'packages/game-sdk');
const manifest = JSON.parse(await readFile(path.join(sdk, 'package.json'), 'utf8'));
const output = path.join(root, 'dist');
await mkdir(output, { recursive: true });
await buildSdk();
if (!process.env.npm_execpath) throw new Error('Run npm run sdk:release from the repository root.');
const packed = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', sdk, '--json', '--pack-destination', output],
  { cwd: root, encoding: 'utf8', windowsHide: true });
if (packed.status !== 0) throw new Error('SDK pack failed.');
const [metadata] = JSON.parse(packed.stdout);
const stem = `arcane-game-sdk-${manifest.version}`;
if (metadata.filename !== `${stem}.tgz`) throw new Error('Unexpected package name.');
const files = metadata.files.map(file => file.path).sort();
const allowed = /^(?:src\/[a-z-]+\.js|examples\/typed-usage\.ts|index\.d\.ts|package\.json|README\.md|API\.md|LICENSE)$/;
for (const file of files) if (!allowed.test(file)) throw new Error(`Unexpected release file: ${file}`);
if (!files.includes('LICENSE') || !files.includes('index.d.ts')) throw new Error('Missing package documentation or types.');
await copyFile(path.join(root, 'public/runtime/arcane-game-sdk/v1/index.js'), path.join(output, `${stem}.browser.mjs`));

// A small, portable ZIP writer (stored entries, UTF-8 names). SDK files only;
// no native archiver, timestamps, credentials, dependencies, or game assets.
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const entries = [];
for (const file of files) entries.push({ name: `${stem}/${file}`, data: await readFile(path.join(sdk, file)) });
entries.push({ name: `${stem}/browser/index.mjs`, data: await readFile(path.join(output, `${stem}.browser.mjs`)) });
const chunks = [], directory = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name), crc = crc32(entry.data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0x21, 12); // 1980-01-01, deterministic archive metadata
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(entry.data.length, 18);
  header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(name.length, 26);
  chunks.push(header, name, entry.data);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(entry.data.length, 20);
  central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42); directory.push(central, name);
  offset += header.length + name.length + entry.data.length;
}
const central = Buffer.concat(directory), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
await writeFile(path.join(output, `${stem}.zip`), Buffer.concat([...chunks, central, end]));
const assets = [`${stem}.tgz`, `${stem}.browser.mjs`, `${stem}.zip`];
const sums = [];
for (const file of assets) {
  const bytes = await readFile(path.join(output, file));
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${file}`);
  console.log(`${file} (${bytes.length} bytes)`);
}
await writeFile(path.join(output, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log(`Packaged ${files.length} SDK files plus browser ESM. Checksums: dist/SHA256SUMS`);
