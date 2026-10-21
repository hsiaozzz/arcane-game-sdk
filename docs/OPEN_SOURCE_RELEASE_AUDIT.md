# Open-source release audit — v0.1.0

Date: 2026-10-21. Scope: the standalone Arcane SDK source export and accompanying public reference platform. This is a release hygiene and focused code review, not an independent penetration test or a guarantee that no defect exists.

## Publication boundary

The release starts from an explicit source allowlist and a new repository history. It includes the browser SDK, typed usage example and tests; the gateway and trusted browser host; original Nakama runtime and PostgreSQL schema; two original small example games; platform launch, registration and test tools; and a generic Cloudflare Pages proxy.

Excluded from the export are the original AI game-generation application, AI-provider configuration and prompts, the private Robo Rumble game and artwork/models/audio, deployment accounts, copied Heroic Labs research pages, original repository history, environment files with values, private credentials, local databases, logs, reports, screenshots, cookies, session files and downloaded native binaries. Third-party dependencies are installed from their upstream distributions and keep their own licenses; see [third-party notices](../THIRD_PARTY_NOTICES.md).

## Checks and results

- Searched source for private-key material, provider and GitHub token formats, complete JWT literals, personal absolute filesystem paths and private production domains. No real credential or personal-path matches found.
- Compared the export privately against 24 known secret values from the existing and independently initialized local development configurations. **Zero exact matches.** Secret values were neither logged nor added to this report.
- Manually reviewed the two initial broad-pattern matches: a deliberate example email in an authentication test and a URL with dummy username/password in a credential-rejection test. Both are test fixtures, not accounts.
- Environment examples leave secret values empty. Initialization generates independent random secrets and Ed25519 keys, writes them to ignored files, refuses to overwrite existing configuration, and does not print secret values.
- Reviewed host/game/administrative boundaries: HttpOnly host cookies; scoped expiring game tokens; exact iframe window and random channel binding; explicit public RPC allowlist; separate runtime and administrator credentials; one-use match admission; server-only settlement; parameterized SQL calls; plain-text DOM rendering for user-controlled social content; and local loopback binding by default.
- Reviewed the fresh npm lockfile. Dependency metadata declares MIT, ISC or Apache-2.0 licenses. The SDK browser package has no runtime dependencies. The npm advisory scan returned **0 reported vulnerabilities** on the audit date. This reflects the advisory database at scan time, not a permanent assurance.
- Inspected generated release contents: npm archive contains exactly 11 allowlisted SDK files; SDK ZIP contains those files plus the browser ESM. No environment files, credentials, game assets, server code, native binaries or dependencies are present. Pattern and known-secret comparisons found no matches in the archive contents or standalone ESM. All three downloadable assets match SHA256SUMS. The final publisher repeats this check after packaging changes.

## Operational limits

Run local development tools only against their isolated loopback stack. For production, generate fresh secrets, configure separate trusted-host and untrusted-content HTTPS origins, keep Nakama/database/admin interfaces private, and configure explicit trusted proxy addresses if needed. The reference match authority is a single-process implementation; multi-replica match ownership needs additional coordination. The bundled social UI refreshes stored messages explicitly and does not provide a global real-time chat delivery guarantee.

Party capacity is a persistent-state/configuration limit up to 10,000, not a claim of 10,000 concurrent users or a 10,000-player simulation. Real-time adapter capacity remains separate. Windows native operation has been exercised; the macOS/Linux launcher targets and Docker configurations require validation on their respective hosts. See the main documentation and test output for the current release's measured checks.

Future contributions and release archives must repeat this boundary and secret review; ignored-file rules alone do not prevent accidental publication.

## Release validation

The standalone export was tested on Windows x64 with Node.js 26.8.1, an independently initialized PostgreSQL database, and official Nakama OSS 3.41.0 on separate loopback ports. `platform:test:local` passed **95/95** tests with zero skips. The public HTTP/WebSocket smoke passed **15/15**, desktop/mobile browser checks **9/9**, reaction-game browser checks **5/5**, and real SDK Party checks **4/4**. Strict TypeScript examples, browser bundling and SDK packaging passed. Offline `npm test` passed 71 tests with the 3 real-service parent suites intentionally skipped.

The native binary download timed out in this session; for the independent Windows validation, the launcher used an existing official archive after verifying its pinned SHA-256, without copying credentials or databases. macOS/Linux full-stack execution and Docker builds were not performed locally. The CI workflow runs source tests, type checks, bundling and packaging on Windows, macOS and Linux; inspect Actions for the actual remote results.
