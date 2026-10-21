# @arcane/game-sdk 0.1.0

Dependency-free browser ESM for games hosted by Arcane. The host owns login and platform credentials. A generated game receives scoped capabilities only. The SDK itself never authenticates; the trusted host creates or reuses a guest session on the first authorized call unless the user has explicitly signed out. After sign-out, the host requires login or an explicit guest choice.

## Install from GitHub

```bash
npm install https://github.com/hsiaozzz/arcane-game-sdk/releases/download/v0.1.0/arcane-game-sdk-0.1.0.tgz
```

The package is not published to the npm registry. [GitHub Releases](https://github.com/hsiaozzz/arcane-game-sdk/releases/latest) also provides a standalone browser ESM bundle, SDK ZIP and `SHA256SUMS`. Download the browser bundle and serve it from your own static origin; GitHub's release download URL is an attachment, not a browser module CDN.

The SDK requires a configured host/backend. The [source repository](https://github.com/hsiaozzz/arcane-game-sdk) includes the open-source platform and two runnable examples; run `npm ci` and `npm run platform:local` from that repository root to try them. A standalone HTML page without a host is not automatically connected to a platform.

## Connect from a hosted game

```js
import { ArcaneGame } from "@arcane/game-sdk";

const game = await ArcaneGame.connect();
const context = await game.context.get();
await game.storage.write({ key: "progress", value: { level: 3 }, expectedVersion: 0 });
const off = game.on("social.closed", () => console.log("Community panel closed"));
await game.social.open({ tab: "friends" }); // trusted host UI
off();
game.close();
```

`connect()` first uses an explicitly supplied transport, then `window.__ARCANE_GAME_TRANSPORT__`, then the host bootstrap in `window.__ARCANE_GAME__`. A page without any configured host rejects with `ArcaneError` code `SDK_NOT_CONFIGURED`. Connection does not implicitly call an RPC. A host may initialize a shared instance for generated games; the package itself does not modify globals.

For a trusted application that already has a short-lived **game-scoped** token:

```js
import { ArcaneGame, createHttpTransport } from "@arcane/game-sdk";
const game = await ArcaneGame.connect({
  transport: createHttpTransport({ gatewayUrl: "https://games.example.com", gameToken }),
});
```

Never pass a platform session, Nakama access/refresh token or publisher credential to a game. An HTTP transport cannot elevate the token it receives; the gateway must authenticate it and enforce game, release, player, capability, ownership and quota limits. Client checks are input hygiene, not a sandbox or authorization layer.

All methods accept a JSON parameter object and optional `{ signal, timeoutMs }`. They dispatch the exact method name through `transport.request(method, params, options)`. RPCs are never automatically retried, including after timeouts: a timed-out mutation may already have committed. Use the service's idempotency key or version/CAS contract before an explicit retry.

Transport timeouts default to 10 seconds and remain active while the body is read. Closing cancels pending requests, detaches listeners and closes the owned transport. Calling `close()` again is harmless. HTTPS/WSS is required except HTTP/WS on localhost. HTTP sends no cookies and follows no redirects. The SDK does not persist a token.

See [API.md](./API.md) for method names, host wire protocol, events and optional match sockets. TypeScript declarations are included in `index.d.ts`. Test with `npm test` from this package directory. Browser builds can bundle `src/index.js` with esbuild targeting ES2020; no Node module is imported by runtime code. This source package has not been published to npm.

Each namespace has explicit parameter and result types. [Typed examples](./examples/typed-usage.ts) cover JSON saves, nullable records, version checks, queueing and authoritative results. A save's `T` describes your schema; validate old/untrusted saved data at runtime before using it. After `npm ci` in the source repository, check the examples with `npm run sdk:typecheck`.

Original SDK code is [MIT licensed](./LICENSE). The platform uses Nakama OSS with independently implemented common systems; it contains no commercial Hiro code. See the repository's [platform guide](https://github.com/hsiaozzz/arcane-game-sdk/blob/main/platform/README.md) for capabilities, deployment and current limits.
