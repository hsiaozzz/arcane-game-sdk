# Third-party notices

The original Arcane SDK, gateway, browser host, custom Nakama runtime, database schema and example games in this repository are licensed under the [MIT License](LICENSE). Third-party software retains its own license. The MIT license does not relicense Nakama, PostgreSQL, Node.js, operating-system packages or container images.

## Software used by the platform and development tools

| Component | Version at v0.1.0 | License | Use |
| --- | --- | --- | --- |
| [Nakama OSS](https://github.com/heroiclabs/nakama) | 3.41.0 | Apache-2.0 | Separately downloaded backend server or container; not bundled in SDK downloads. |
| [PostgreSQL](https://www.postgresql.org/about/licence/) | 16.14 (production image/native local package) | PostgreSQL License | Separately installed database; not bundled in SDK downloads. |
| [ws](https://github.com/websockets/ws) | 8.22.0 | MIT | Server WebSocket transport. |
| [embedded-postgres](https://github.com/leinelissen/embedded-postgres) and platform packages | 16.14.0-beta.17 | MIT for the wrapper; bundled PostgreSQL and libraries retain upstream licenses | Local development database installer. |
| [node-postgres](https://github.com/brianc/node-postgres) (pg) | 8.23.1 | MIT | Local database tests and load tools. |
| [esbuild](https://github.com/evanw/esbuild) and platform packages | 0.28.2 | MIT | Browser SDK bundler. |
| [Playwright](https://github.com/microsoft/playwright), playwright-core | 1.63.0 | Apache-2.0 | Browser tests; downloaded browsers retain their own licenses. |
| [TypeScript](https://github.com/microsoft/TypeScript) | 5.9.3 | Apache-2.0 | Type declaration checks. |

The browser SDK has **no third-party runtime dependencies**. The npm-compatible SDK archive and standalone browser module contain original Arcane code, declarations, examples and documentation; they do not embed Nakama, PostgreSQL, ws, Playwright or esbuild.

Transitive npm dependencies in the initial lockfile use MIT or ISC licenses: async-exit-hook, pg-cloudflare, pg-connection-string, pg-int8 (ISC), pg-pool, pg-protocol, pg-types, pgpass, postgres-array, postgres-bytea, postgres-date, postgres-interval, split2 (ISC), and xtend. Optional esbuild and embedded-postgres platform packages follow their package notices. Exact resolved packages, hashes and declared licenses are recorded in [package-lock.json](package-lock.json). License texts and copyright notices remain in dependencies installed by npm. If redistributing those dependencies or a container image, retain their included licenses and notices, including notices for native libraries and base images.

The native launcher retrieves Nakama only from the official Heroic Labs GitHub release and verifies a pinned SHA-256 digest. Nakama's [license](https://github.com/heroiclabs/nakama/blob/v3.41.0/LICENSE) and applicable upstream notices remain in force. Dockerfiles reference Node.js, Alpine, PostgreSQL and Nakama images; these are separate distributions with additional component notices.

## Hiro and trademarks

This project uses Nakama Open Source and original Arcane systems. It does not include Heroic Labs Hiro commercial source, licensed Hiro packages, scraped documentation, or Hiro assets. Public architectural ideas informed the separation of definitions, player state, authorization and server-side settlement. Nakama, Hiro, PostgreSQL, Node.js and other names belong to their respective owners. This repository does not imply endorsement or affiliation.
