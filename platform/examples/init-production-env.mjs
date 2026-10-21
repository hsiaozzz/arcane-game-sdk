import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const target = new URL('../.env', import.meta.url);
let template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const names = ['POSTGRES_PASSWORD', 'NAKAMA_SERVER_KEY', 'NAKAMA_HTTP_KEY', 'NAKAMA_SESSION_KEY', 'NAKAMA_REFRESH_KEY',
  'NAKAMA_CONSOLE_PASSWORD', 'ARCANE_GATEWAY_KEY', 'ARCANE_ADMIN_KEY', 'ARCANE_TOKEN_SECRET', 'ARCANE_ADMIN_TOKEN'];
for (const name of names) template = template.replace(new RegExp(`^${name}=$`, 'm'), `${name}=${randomBytes(32).toString('hex')}`);
const pair = generateKeyPairSync('ed25519');
for (const [name, key, type] of [['ARCANE_MATCH_PRIVATE_KEY', pair.privateKey, 'pkcs8'], ['ARCANE_MATCH_PUBLIC_KEY', pair.publicKey, 'spki']]) {
  const value = Buffer.from(key.export({ type, format: 'pem' })).toString('base64');
  template = template.replace(new RegExp(`^${name}=$`, 'm'), `${name}=${value}`);
}
try {
  await writeFile(target, template, { flag: 'wx', mode: 0o600 });
  console.log('Created platform/.env with independent random secrets. Set your host/content domains before starting. Values were not printed.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('platform/.env already exists; preserved without reading or printing it.');
}
