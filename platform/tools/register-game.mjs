import { readFile } from 'node:fs/promises';
import { CliError, options, fail, id, scope, gatewayOrigin, publishingCredential, controlRequest, runIfMain } from './cli-common.mjs';

const help = `Register or activate an immutable game release through the trusted platform gateway.

Usage:
  node platform/tools/register-game.mjs [register] --gateway URL --manifest FILE
    --game-id ID --environment ENV --release-id ID --build-hash HASH
    [--entry-url URL] [--publisher-id ID] [--activate]
  node platform/tools/register-game.mjs activate --gateway URL
    --game-id ID --environment ENV --release-id ID --build-hash HASH

Registration stages the release with activate:false by default. --activate makes
it immediately active. The separate activate command verifies the saved hash.
The default gateway is ARCANE_PUBLIC_URL. Credentials are read only from
ARCANE_PUBLISH_TOKEN (publisher-scoped bearer), or ARCANE_ADMIN_TOKEN (platform
operator; --publisher-id is required when registering with this master key).
Publisher credentials cannot appoint a different publisher. No player token,
Nakama runtime secret or bearer token should be passed on the command line.
`;
const schema = Object.fromEntries(['gateway', 'manifest', 'game-id', 'environment', 'release-id', 'build-hash', 'entry-url', 'publisher-id'].map(key => [key, { type: 'string' }]));
schema.activate = { type: 'boolean' };

function buildHash(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) fail('A valid --build-hash is required.');
  return value;
}
async function loadManifest(file) {
  if (!file) fail('--manifest is required for registration.');
  let text; try { text = await readFile(file, 'utf8'); } catch { fail('The manifest file could not be read.'); }
  if (Buffer.byteLength(text, 'utf8') > 32768) fail('The manifest exceeds the 32 KiB limit.');
  let manifest; try { manifest = JSON.parse(text); } catch { fail('The manifest must be valid JSON.'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schemaVersion !== '1.0' || manifest.sdkVersion !== '0.1' || !Array.isArray(manifest.capabilities))
    fail('The manifest must use schemaVersion 1.0, sdkVersion 0.1 and a capabilities array.');
  return manifest;
}

export async function main(args, { env = process.env, fetchImpl = fetch, output = text => console.log(text) } = {}) {
  const { values, positionals } = options(args, schema);
  if (values.help) { output(help); return; }
  const action = positionals[0] || 'register';
  if (positionals.length > 1 || !['register', 'activate'].includes(action)) fail('Use register or activate. Run with --help for usage.');
  const context = scope(values), origin = gatewayOrigin(values.gateway || env.ARCANE_PUBLIC_URL), token = publishingCredential(env);
  const body = { ...context, buildHash: buildHash(values['build-hash']) };
  if (action === 'register') {
    body.manifest = await loadManifest(values.manifest);
    body.activate = values.activate === true;
    if (values['publisher-id'] && env.ARCANE_PUBLISH_TOKEN) fail('--publisher-id is only accepted with ARCANE_ADMIN_TOKEN; publisher credentials use their registered owner.');
    if (values['publisher-id']) body.publisherId = id(values['publisher-id'], 'publisher-id', 128);
    if (!env.ARCANE_PUBLISH_TOKEN && env.ARCANE_ADMIN_TOKEN && !body.publisherId) fail('--publisher-id is required when registering with ARCANE_ADMIN_TOKEN.');
    if (values['entry-url']) {
      let entry; try { entry = new URL(values['entry-url']); } catch { fail('--entry-url must be an HTTP(S) URL.'); }
      if (!['http:', 'https:'].includes(entry.protocol) || entry.username || entry.password || entry.search || entry.hash) fail('--entry-url must be HTTP(S) without credentials, query or fragment.');
      body.entryUrl = entry.href;
    }
  } else if (values.manifest || values.activate || values['entry-url'] || values['publisher-id']) fail('activate accepts only gateway, game-id, environment, release-id and build-hash.');
  const result = await controlRequest(origin, `/v1/admin/games/${action}`, body, token, fetchImpl);
  if (result.gameId !== context.gameId || result.environment !== context.environment || result.releaseId !== context.releaseId || result.buildHash !== body.buildHash || typeof result.active !== 'boolean')
    throw new CliError('The gateway returned a release that does not match the requested context.');
  output(JSON.stringify({ gameId: context.gameId, environment: context.environment, releaseId: context.releaseId, buildHash: body.buildHash, active: result.active }));
  return result;
}
runIfMain(import.meta.url, main);
