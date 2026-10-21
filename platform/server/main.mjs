import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createNakamaBridge } from './nakama.mjs';
import { createMatchTicketService } from './tokens.mjs';
import { createGateway } from './gateway.mjs';
import { attachTurnMatchServer } from './turn-match.mjs';
import { attachScoreRaceServer } from './score-race.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const textFile = async relative => readFile(path.join(root, relative));
export async function createPlatform({ env = process.env, fetchImpl = fetch, logger = console } = {}) {
  const publicUrl = env.ARCANE_PUBLIC_URL || 'http://127.0.0.1:7400';
  const bridge = createNakamaBridge({ url: env.NAKAMA_URL || 'http://127.0.0.1:7450', serverKey: env.NAKAMA_SERVER_KEY,
    httpKey: env.NAKAMA_HTTP_KEY, gatewayKey: env.ARCANE_GATEWAY_KEY, adminKey: env.ARCANE_ADMIN_KEY, fetchImpl });
  const tickets = createMatchTicketService({ privateKey: Buffer.from(env.ARCANE_MATCH_PRIVATE_KEY || '', 'base64').toString('utf8') });
  const wsBase = new URL(publicUrl); wsBase.protocol = wsBase.protocol === 'https:' ? 'wss:' : 'ws:';
  const adapters = {
    'turn-based-v1': { endpoint: new URL('/v1/matches', wsBase).href, serverId: 'turn-based-v1' },
    'score-race-v1': { endpoint: new URL('/v1/score-race', wsBase).href, serverId: 'score-race-v1' },
    ...(env.ARCANE_ROBO_ENDPOINT ? { 'robo-rumble-authoritative-v1': { endpoint: env.ARCANE_ROBO_ENDPOINT,
      protocol: 'robo-rumble-v1', serverId: 'robo-rumble-authoritative-v1' } } : {}),
  };
  const allowedFiles = new Map([
    ['/sdk/index.js', 'public/runtime/arcane-game-sdk/v1/index.js'],
    ['/platform/browser/host-broker.js', 'platform/browser/host-broker.js'],
    ['/platform/browser/social-overlay.js', 'platform/browser/social-overlay.js'],
    ['/platform/browser/published-host.js', 'platform/browser/published-host.js'],
    ['/examples/launcher.js', 'platform/examples/launcher.js'],
    ['/examples/take-away/game.html', 'platform/examples/take-away/game.html'],
    ['/examples/score-race/game.html', 'platform/examples/score-race/game.html'],
  ]);
  async function staticHandler(req, res, url) {
    if (req.method !== 'GET') return false;
    let file = allowedFiles.get(url.pathname);
    if (url.pathname === '/' || /^\/play\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(url.pathname)) file = 'platform/examples/launcher.html';
    if (!file) return false;
    const body = await textFile(file);
    // Sandboxed game frames have an opaque origin. These files are public code,
    // so module loads must work without granting any credentialed API access.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.removeHeader('Access-Control-Allow-Credentials');
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' blob: 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https: wss:; frame-src 'self' http://127.0.0.1:* http://localhost:* https: blob:; img-src 'self' data: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    res.statusCode = 200; res.end(body); return true;
  }
  const gateway = createGateway({ bridge, tokenSecret: env.ARCANE_TOKEN_SECRET, adminToken: env.ARCANE_ADMIN_TOKEN,
    publisherKeys: env.ARCANE_PUBLISHER_KEYS ? JSON.parse(env.ARCANE_PUBLISHER_KEYS) : {}, tickets, ticketService: tickets,
    adapterRegistry: adapters, publicUrl, allowedOrigins: (env.ARCANE_ALLOWED_ORIGINS || new URL(publicUrl).origin).split(',').map(s => s.trim()),
    allowedGameOrigins: (env.ARCANE_GAME_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    trustedProxyIps: (env.ARCANE_TRUSTED_PROXY_IPS || '').split(',').map(s => s.trim()).filter(Boolean),
    allowLocalGameOrigin: env.ARCANE_LOCAL_DEVELOPMENT === 'true', staticHandler, logger });
  const matches = attachTurnMatchServer({ server: gateway.server, bridge, tickets, logger, otherPaths: ['/v1/score-race'] });
  const scoreRaces = attachScoreRaceServer({ server: gateway.server, bridge, tickets, logger, otherPaths: ['/v1/matches'] });
  return { ...gateway, tickets, matches, scoreRaces, async close() { await scoreRaces.close(); await matches.close(); await gateway.close(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createPlatform();
  const host = process.env.ARCANE_BIND_HOST || '127.0.0.1';
  const port = Number(process.env.ARCANE_PORT || 7400);
  app.server.listen(port, host, () => console.log(`Arcane platform: ${process.env.ARCANE_PUBLIC_URL || `http://${host}:${port}`}`));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
}
