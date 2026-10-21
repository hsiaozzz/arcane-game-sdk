# Arcane Nakama runtime contract v0.1

This is an independently implemented Nakama OSS runtime. It does not contain or require the commercial Hiro product. JSON definitions and player state are separate.

## Transport and trust

Server-only RPC: `POST /v2/rpc/arcane_dispatch?http_key=<NAKAMA_HTTP_KEY>&unwrap=true`.

```json
{"gatewayKey":"<server secret>","context":{"gameId":"demo","environment":"development","releaseId":"r1","platformUserId":"verified platform subject"},"method":"profile.get","params":{}}
```

Return value is the method result, serialized as JSON by the Nakama RPC. Errors use Nakama/gRPC codes: 3 invalid input, 5 absent, 6 conflict, 7 forbidden, 8 limit, 9 precondition, 16 authentication.

- `ctx.userId` is always forbidden, including when a user presents the correct server secret.
- Public methods require `ARCANE_GATEWAY_KEY`; `admin.*` require a separate `ARCANE_ADMIN_KEY`, both at least 32 characters and different.
- The gateway authenticates `platformUserId` and binds all context fields to its authorized session. The runtime independently loads the immutable registered release and enabled capabilities. Supplying arbitrary unregistered context is rejected.
- Platform identities, internal Nakama UUIDs, administrative keys and trusted adapter secrets are never returned by public methods. Public user references are opaque `gameUserId` values scoped to a game and environment.
- Server environment `ARCANE_ADAPTER_IDS` is a comma-separated adapter allowlist (runtime default `turn-based-v1,score-race-v1,robo-rumble-authoritative-v1`; production Compose default excludes optional Robo). No game-supplied executable module or URL is loaded. A legacy manifest multiplayer endpoint may only be a relative path, is removed from public/match config, and never chooses a server; the gateway's adapter registry controls the endpoint.
- Platform registration/matchmaking/result validation supports `2 <= minPlayers <= maxPlayers <= 100`. Limits must also fit the selected authority: `score-race-v1` supports the whole 2–100 range, `turn-based-v1` requires exactly `2/2`, and `robo-rumble-authoritative-v1` supports at most 12. Invalid configurations fail during release registration. Matchmaking groups when `minPlayers` is reached; use equal min/max to require a fixed-size match (for example `100/100`), rather than expecting `2/100` to wait for 100 players.
- `params` defaults to `{}`. Request JSON is bounded to 128 KiB; manifests 32 KiB; save values 16 KiB; save key count 100 per player. All clocks are server Unix milliseconds.

## Registration

`admin.registerGame` params:

```json
{"gameId":"demo","publisherId":"verified-owner","environment":"development","releaseId":"r1","buildHash":"sha256-or-build-identifier","manifest":{"schemaVersion":"1.0","sdkVersion":"0.1","capabilities":["profile","storage","friends","chat","party","matchmaking","leaderboards","achievements","economy","tournaments"],"multiplayer":{"adapter":"turn-based-v1","minPlayers":2,"maxPlayers":2,"endpoint":"/v1/matches"},"leaderboards":{"points":{"sort":"descending","period":"all_time","writePolicy":"verified_match_result","metric":"points","operator":"sum"}},"achievements":{"first_win":{"name":"First win","event":"match.won","target":1,"reward":{"coins":100}}}}}
```

Optional registration field `entryUrl` is a trusted publication entry, separate from manifest. The runtime validates HTTP(S) without credentials/query/hash; the gateway additionally enforces its CDN origin allowlist. It is stored immutably with the release. Returns `{gameId,publisherId,environment,releaseId,buildHash,entryUrl,manifest}`. An exact retry is accepted. Changing an existing release or game publisher is a conflict; publishing a new release is allowed. `period` supports `all_time`, `daily`, `weekly`; `sort` supports `ascending` and `descending`. Existing leaderboard and tournament definitions cannot change under the same ID across releases: choose a new ID to change scoring semantics. Optional `tournaments` is a mapping of `{name,startAt,endAt,leaderboardId}` referencing a configured leaderboard; no client-written tournament score or prize grants.

Optional `activate:false` stages an immutable release without exposing it to public RPCs or moving the current release. Registration defaults to active for initial seeds. An exact registration retry preserves activation state and current pointer. `admin.activateGame` takes `{gameId,environment,releaseId,buildHash}`, verifies the staged hash, marks the release active and moves the current pointer; retries succeed. Registration responses also include `active`.

`admin.getGame`: `{gameId,environment,releaseId?}`; returns registered game/release. Without releaseId reads the current release. No user context is needed for admin methods.

`admin.registerMatch`: `{gameId,environment,releaseId,matchRunId,adapterId,gameUserIds,mode?}`. Requires a trusted adapter equal to the registered manifest adapter, 2–100 distinct registered users within configured player limits, immutable roster and release. Returns `{matchRunId,status,gameUserIds,adapterId,releaseId,mode}`. Exact retry succeeds. A conflicting retry fails.

`admin.settleMatch`: `{gameId,environment,matchRunId,adapterId,reason:'finished'|'abandoned',results:[{gameUserId,rank,score,points,won?}],finishedAt?}`. Results must exactly match the registered human roster; ranks are unique integers 1 through the manifest's maxPlayers for finished games, null for abandoned games. Gaps are permitted when bots take some ranks. `score` and `points` are bounded nonnegative integers. Optional `won` is boolean, defaulting to rank 1; the frozen event includes it. The registered release supplies all achievement/reward definitions. Abandoned games give no leaderboard score, achievement progress or currency. One immutable event and all result/progress/leaderboard deltas commit in a single PostgreSQL transaction function. Same-event retry succeeds without additional deltas; conflicting event fails. Returns `{matchRunId,status:'settled',duplicate:boolean,reason}`. Servers—not game clients—calculate and submit these values. Use a stable finishedAt on retries; omission means match registration time for deterministic retries.

`admin.getMatch`: `{gameId,environment,matchRunId}` returns `{gameId,environment,matchRunId,adapterId,gameUserIds,status,releaseId,createdAt,config,state,stateVersion}`. State is null and version 0 initially.

`admin.saveMatchState`: `{gameId,environment,releaseId,matchRunId,adapterId,expectedVersion,state}` returns `{stateVersion}`. The state must be an object of at most 32 KiB. Updates use atomic compare-and-swap and reject a settled match. A state with `status:'finished'` is immutable. Persist validated adapter input before broadcasting it.

`admin.pendingMatches`: `{adapterId,limit?:1..100,gameId?,environment?,releaseId?}` returns `{matches:[<admin.getMatch object>]}` restricted to unsettled matches whose durable state has `status:'finished'`. This lets the gateway recover `state.pendingResult` after restart.

`admin.activeMatches`: `{adapterId,limit?:1..100,after?:cursor,gameId?,environment?,releaseId?}` returns `{matches:[<admin.getMatch object>],cursor:string|null}` for all unsettled matches, including initial null states and playing states. Default limit is 100. Results are ordered by registration time plus game/environment/run IDs; pass each opaque cursor back unchanged until null. The cursor uses a JSON tuple string to remain unambiguous when IDs contain colons. This lets the trusted adapter reconstruct active rooms and apply its persisted deadline policy after restart. Recovery is for one authoritative adapter process; it does not imply multi-process room ownership.

`admin.createSession`: `{sessionId,platformUserId,expiresAt}` creates an immutable durable host session, with verified internal Nakama UUID and expiry at most 30 days away. `admin.getSession` and `admin.revokeSession` accept `{sessionId}`. Return `{sessionId,platformUserId,expiresAt,revoked}`. Reads reject expired/revoked sessions; these server-only methods are the only intentional internal identity responses. No browser receives these responses directly.

`admin.consumeMatchTicket`: `{gameId,environment,releaseId,matchRunId,adapterId,nonce,gameUserId,expiresAt}` validates match roster/context/status and consumes a nonce exactly once, durably. Expiry must be in the next 60 seconds. Returns `{consumed:true}`.

`admin.consumeAdmissionTicket`: same payload without matchRunId; checks registered release/adapter and game user before a room exists. Uses the same global nonce uniqueness table. No registration or settlement authority is granted to the player holding an admission ticket.

## Public methods

`context.get` always works for a registered release; the remaining methods require the capability matching their prefix. The release is part of every request context.

| Method | Params | Result |
|---|---|---|
| `context.get` | `{}` | `{gameId,environment,releaseId,buildHash,sdkVersion,capabilities,gameUserId,multiplayer}` |
| `profile.get` | `{gameUserId?}` | `{gameUserId,displayName,avatar,metadata,version}`; no platform/Nakama identity |
| `profile.update` | `{displayName?,avatar?,metadata?,expectedVersion}` | updated profile; compare-and-swap conflict on stale version |
| `storage.read` | `{collection:'default',key}` | `{collection,key,value,version,updatedAt}` or `{item:null}` |
| `storage.write` | `{collection:'default',key,value,expectedVersion}` | saved item; 0 means create-only; update requires current version |
| `storage.delete` | `{collection:'default',key,expectedVersion}` | `{deleted:true}`; version required |
| `storage.list` | `{collection:'default',limit?:1..50,cursor?:lastKey}` | `{items,cursor}` |
| `friends.list` | `{}` | `{friends,incoming,outgoing,blocked}`; entries contain gameUserId + displayName |
| `friends.request` | `{gameUserId}` | `{status:'requested'}` |
| `friends.accept` | `{gameUserId}` | `{status:'accepted'}`; only incoming requests |
| `friends.remove` | `{gameUserId}` | `{removed:true}` |
| `friends.block` | `{gameUserId}` | `{blocked:true}` |
| `chat.channels` | `{}` | `{channels:[{channelId,type,...}]}`; global, friend DMs, current party |
| `chat.history` | `{channelId,limit?:1..50,before?:messageId}` | `{messages,cursor}`; sender public identity only |
| `chat.send` | `{channelId,text}` | `{message}`; 1–280 characters, 5 sends / 10 seconds per game user |
| `party.create` | `{maxMembers?:1..10000,joinPolicy?:'invite'|'code'}` | `{party}`; capacity must not exceed release `party.maxMembers` (default 32), frozen at creation |
| `party.get` | `{partyId?,cursor?:gameUserId,inviteCursor?:partyId,limit?:1..100}` | `{party,invites,inviteCursor}`; members and invitations use separate live keyset pages; access only members/invitees |
| `party.invite` | `{partyId,gameUserId}` | `{invited:true}`; leader only, friend target |
| `party.accept` | `{partyId}` | `{party}`; invitation required, serialized admission enforces the party's configured capacity |
| `party.join` | `{partyId,joinCode}` | `{party}`; code-enabled party, no friendship requirement, atomic capacity/one-party checks; repeat join of the same member is idempotent |
| `party.leave` | `{partyId}` | `{left:true}`; transfers leadership to oldest remaining member |
| `party.ready` | `{partyId,ready:boolean}` | `{party}` |
| `matchmaking.join` | `{mode?:'default'}` | `{queue}`; solo queue only in v0.1; same game/environment/release |
| `matchmaking.status` | `{queueId?}` | `{queue:null|{queueId,status,matchRunId,adapterId,gameUserIds,...}}` |
| `matchmaking.cancel` | `{queueId?}` | `{cancelled:boolean}`; only own waiting ticket |
| `match.get` | `{matchRunId}` | `{matchRunId,adapterId,gameUserIds,status,releaseId,createdAt,config,result,state}`; only roster member, same release; capability `match` or `matchmaking` |
| `leaderboards.list` | `{leaderboardId,limit?:1..50,offset?:0..1000}` | `{leaderboardId,period,records,ownRecord,total}`; records carry gameUserId, displayName, rank, score |
| `achievements.list` | `{}` | `{achievements:[{id,name,event,target,count,completed,claimed,reward}]}` |
| `achievements.claim` | `{achievementId}` | `{claimed:true,duplicate:boolean,reward:{coins},balance}`; one immutable claim per game/environment/user/achievement |
| `economy.get` | `{}` | `{currencies:{coins},version}`; read-only to clients |
| `tournaments.list` | `{}` | `{tournaments:[{id,name,startAt,endAt,leaderboardId,joined,status}]}` |
| `tournaments.join` | `{tournamentId}` | `{joined:true,duplicate:boolean}`; only active configured tournaments |
| `tournaments.standings` | `{tournamentId,limit?,offset?}` | independent event scores for registered entrants |

`match.ticket` belongs to the gateway/adapter and is deliberately not implemented by this runtime. The gateway must bind tickets to verified game user, game, environment, release and registered match; runtime keys never enter browser bundles.

`match.get` remains readable after settlement so a player who misses the final
WebSocket frame can recover the result through the existing scoped HTTP RPC.
`result` is null until settlement commits; then it is the immutable
`{adapterId,releaseId,reason,finishedAt,results:[{gameUserId,rank,won,score,points}]}`
event. It contains only public game user IDs and trusted match facts. `state`
is null for adapters without an explicitly approved public schema. For
`turn-based-v1`, it exposes only existing `status,stones,maxTake,turn,move,
deadline,startedAt,winner,reason,finishedAt`, a nested `lastMove:{player,take}`,
the frozen `players` roster, and `settlement:'pending'|'confirmed'` on finished
states. Internal sequence maps, pending result envelopes and future unlisted
adapter fields are never returned.

For `score-race-v1`, `match.get.state` projects only `status,scores,targetScore,
deadline,startedAt,winner,reason,finishedAt,players,settlement`. Per-user challenge
data is delivered only over the authorized player's match socket; private
`seq,lastActionAt,challengeIds,targets,pendingResult` fields are not public RPC
state. The adapter is a lightweight server-validated reaction game, not a
generic 100-player physics engine. It validates inputs in arrival order within
a 20ms room window, commits one CAS state per accepted batch before issuing
ACKs, coalesces room-wide state broadcasts at 10Hz, and abandons incomplete rosters
after 120 seconds without rewards. See [template notes](../examples/score-race/README.md).
The score adapter caches a successful socket session check for at most 5 seconds,
forces background checks every 5 seconds, and validates expired caches in parallel
before applying input. Revocation can take about 5 seconds to reach an existing
socket; confirmed revocation closes it immediately. Each socket has at most 4
queued inputs and each room 400; backend failures never acknowledge an uncommitted
batch. This policy belongs to this adapter, not all SDK transports or engines.
When a state-write response is lost, the score authority reads the durable match
back and verifies context, roster, version and state. Only a confirmed matching
commit is ACKed. If reconciliation is unavailable, later writes wait for a
successful read; input/recovery scans reload the version rather than staying
permanently stuck on stale CAS state. Confirmed pending results continue through
the existing idempotent settlement path.

## Consistency and limits

Leaderboard state is stored directly in namespaced SQL rather than eventually projecting into global Nakama leaderboard IDs. Weekly buckets reset at Monday 00:00 UTC. Player names are joined at read time. Currency grants only occur through successful, idempotent achievement claims; settlement advances achievements but does not auto-claim them. Achievement claim eligibility/reward is frozen when progress first reaches its target, so later configuration changes cannot increase an already earned reward. Tournament scores are independent ledgers for entrants' settled matches within the configured event window, not lifetime scores. Waiting queue tickets expire after 10 minutes when the queue is next polled; matched games require adapter completion/abandonment.

Social/chat/party data is scoped to game + environment. Queue matching is solo only; party membership does not silently turn into party matchmaking. The gateway must not present party queue support until a group-aware matcher is implemented. Tournaments score entrants' matches during the configured event window; knockout brackets and prize distribution are not implemented. No payment system, real-money wallet, random item economy, arbitrary code deployment, or transparent multi-region clustering is implied.

Party definitions use `manifest.party = {maxMembers: 1..10000}`. Omission defaults to 32 for new parties; a creator can request a smaller size. Existing pre-upgrade parties keep their previous capacity of 8. A returned party contains `{partyId,leaderId,createdAt,maxMembers,memberCount,inviteCount,readyCount,members,cursor,self}`. `members` is at most 100 rows sorted by opaque game user ID; mutation responses default to 50. `self` always gives the caller's status/ready state even if their row is outside the current page. Counts include all rows; a roster page can include invited rows, while `memberCount`/`readyCount` count accepted members only. `invites[].party` is a summary with no nested roster. The separate `inviteCursor` pages the caller's pending invitations. Pages are live views, not a frozen snapshot during concurrent membership changes.

The party capacity is a social state limit, independent of a gameplay adapter's match size. Default `joinPolicy:'invite'` requires a leader and an existing friend relationship for invitations. Large groups can instead use `joinPolicy:'code'`: the database generates 64 random hex characters from two independent random UUIDs (about 244 random bits). Only the current leader's party response includes `joinCode`; the summary includes `joinPolicy` but never the code. `party.join` accepts non-friends holding this bearer secret, so it must be privately shared and never logged. The current code remains valid until the party is deleted; there is no code rotation API. Pending invitations per party are capped at its configured capacity and per invited player at 100. The friendship quota remains separate (100 relationships per player). Reads are paged; there is no automatic fan-out of 10,000 ready-state notifications or claim of 10,000 concurrent gameplay connections.
