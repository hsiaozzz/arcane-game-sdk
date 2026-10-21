import { open } from 'node:fs/promises';
import path from 'node:path';
import { createTokenService } from '../server/tokens.mjs';
import { options, fail, id, scope, runIfMain } from './cli-common.mjs';

const help = `Create a short-lived server workload credential on the trusted platform host.

Usage:
  node platform/tools/create-workload-token.mjs --game-id ID --environment ENV
    --release-id ID --adapter-id ID --subject SERVER_ID --output NEW_FILE
    [--actions register,get,state,settle,consume] [--ttl-seconds 3600]

ARCANE_TOKEN_SECRET must match the gateway's signing secret. This command runs
only on a trusted operator host; signing secrets never belong on game servers
or in browser builds. Every credential binds one game, environment, release,
adapter and explicit action set. Wildcards are rejected. TTL is 1–86400 seconds.
The output is a new JSON file with token, expiresAt and its scope. Existing
files are never overwritten. The token and signing secret are never printed.
Provision the output securely and renew it before expiresAt.
`;
const schema = Object.fromEntries(['game-id', 'environment', 'release-id', 'adapter-id', 'subject', 'output', 'actions', 'ttl-seconds'].map(key => [key, { type: 'string' }]));
const allowedActions = ['register', 'get', 'state', 'settle', 'consume'];

export async function main(args, { env = process.env, output = text => console.log(text), now = Date.now } = {}) {
  const { values, positionals } = options(args, schema);
  if (values.help) { output(help); return; }
  if (positionals.length) fail('Unexpected positional arguments. Run with --help for usage.');
  const context = { ...scope(values), adapterId: id(values['adapter-id'], 'adapter-id') };
  const subject = id(values.subject, 'subject', 128);
  const actions = (values.actions || allowedActions.join(',')).split(',');
  if (!actions.length || new Set(actions).size !== actions.length || actions.some(value => !allowedActions.includes(value))) fail('--actions must be a comma-separated subset of register,get,state,settle,consume without duplicates.');
  const rawTtl = values['ttl-seconds'] || '3600';
  if (!/^\d+$/.test(rawTtl) || !Number.isSafeInteger(Number(rawTtl)) || Number(rawTtl) < 1 || Number(rawTtl) > 86400) fail('--ttl-seconds must be an integer from 1 to 86400.');
  if (!values.output || values.output.includes('\0')) fail('--output must name a new credential file.');
  if (typeof env.ARCANE_TOKEN_SECRET !== 'string' || env.ARCANE_TOKEN_SECRET.length < 32) fail('Set ARCANE_TOKEN_SECRET on the trusted platform host.');
  const issued = createTokenService({ secret: env.ARCANE_TOKEN_SECRET, now }).issue('arcane-workload', subject, { ...context, actions }, Number(rawTtl) * 1000);
  const target = path.resolve(values.output);
  let file;
  try { file = await open(target, 'wx', 0o600); }
  catch (error) { fail(error.code === 'EEXIST' ? 'The output file already exists; choose a new path.' : 'The output file could not be created. Check its parent directory and permissions.'); }
  try { await file.writeFile(JSON.stringify({ token: issued.token, expiresAt: issued.expiresAt, subject, ...context, actions }, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  output(JSON.stringify({ output: target, expiresAt: issued.expiresAt, subject, ...context, actions }));
  return { output: target, expiresAt: issued.expiresAt };
}
runIfMain(import.meta.url, main);
