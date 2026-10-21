import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class CliError extends Error {}
export const fail = message => { throw new CliError(message); };
export function options(args, schema) {
  try { return parseArgs({ args, options: { help: { type: 'boolean', short: 'h' }, ...schema }, allowPositionals: true, strict: true }); }
  catch { fail('Invalid arguments. Run with --help for usage.'); }
}
export function id(value, label, max = 96) {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) fail(`A valid --${label} is required (letters, digits, dots, underscores and dashes; at most ${max} characters).`);
  return value;
}
export function gatewayOrigin(value) {
  let url; try { url = new URL(value); } catch { fail('Set --gateway or ARCANE_PUBLIC_URL to the trusted platform gateway URL.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    fail('The gateway must be an HTTPS origin, or a loopback HTTP origin for local development.');
  return url.origin;
}
export function publishingCredential(env) {
  const token = env.ARCANE_PUBLISH_TOKEN || env.ARCANE_ADMIN_TOKEN;
  if (typeof token !== 'string' || token.length < 32 || /[\s\x00-\x1f\x7f]/.test(token)) fail('Set ARCANE_PUBLISH_TOKEN to a trusted publisher credential, or ARCANE_ADMIN_TOKEN for platform operations.');
  return token;
}
export function scope(values) {
  return { gameId: id(values['game-id'], 'game-id'), environment: id(values.environment, 'environment'), releaseId: id(values['release-id'], 'release-id') };
}
export async function controlRequest(origin, route, body, token, fetchImpl = fetch) {
  let response;
  try { response = await fetchImpl(origin + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); }
  catch { fail('The trusted gateway could not be reached. Check its URL and availability.'); }
  let result; try { result = await response.json(); } catch { fail('The trusted gateway returned an invalid response.'); }
  if (!response.ok) {
    const code = result?.error?.code || result?.code;
    fail(`The gateway rejected the operation (HTTP ${response.status}${typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? `, ${code}` : ''}).`);
  }
  return result;
}
export function runIfMain(url, main) {
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url))
    main(process.argv.slice(2)).catch(error => { console.error(error instanceof CliError ? error.message : 'The operation failed. Check the configuration and file permissions.'); process.exitCode = 1; });
}
