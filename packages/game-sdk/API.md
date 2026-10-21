# API and transport contract

Named exports: `ArcaneGame`, `ArcaneError`, `createHttpTransport`, `createHostTransport`, `createMatchConnection`, `SDK_VERSION`, `PROTOCOL_VERSION`, `RPC_METHODS`.

`await ArcaneGame.connect(options?)` returns an `ArcaneGame` instance. Every capability method below accepts `(params = {}, options = {})` and returns a Promise of the gateway result. Params must be plain JSON, finite numbers, at most 24 levels and 65,536 bytes per RPC. The service defines individual parameter/result schemas and authorizes the operation; the SDK does not inject a client-controlled game ID.

| Namespace | Methods |
|---|---|
| `context` | `get` |
| `profile` | `get`, `update` |
| `storage` | `read`, `write`, `delete`, `list` |
| `friends` | `list`, `request`, `accept`, `remove`, `block` |
| `chat` | `channels`, `history`, `send` |
| `party` | `create`, `get`, `invite`, `accept`, `join`, `leave`, `ready` |
| `matchmaking` | `join`, `status`, `cancel` |
| `match` | `get`, `ticket` |
| `leaderboards` | `list` |
| `achievements` | `list`, `claim` |
| `economy` | `get` |
| `tournaments` | `list`, `join`, `standings` |
| `social` | `open` |

The namespace declarations expose the public parameter/result schemas in [index.d.ts](./index.d.ts). See [typed usage](./examples/typed-usage.ts) for versioned saves, nullable queue/ranking results and committed match results; the [backend contract](https://github.com/hsiaozzz/arcane-game-sdk/blob/v0.1.0/platform/nakama/CONTRACT.md) describes runtime limits. The optional generic on `storage.read<T>` and `storage.list<T>` describes your saved JSON schema and performs no runtime validation. Other built-in methods return their defined result shapes, rather than an arbitrary caller-selected generic.

There is deliberately no client settlement, currency grant, leaderboard write, arbitrary Nakama RPC, arbitrary Nakama collection access or platform account API. An operation may reject `CAPABILITY_DISABLED` or `NOT_IMPLEMENTED` when the gateway has not enabled its service; the presence of a method does not claim that every backend capability is installed.

`game.on(event, (data, eventName) => {})` returns an unsubscribe function. `"*"` subscribes to all received events. Event delivery is push-only and transport-specific; HTTP alone does not poll or synthesize events. Listener exceptions are isolated. Event names are defined by the host/service, such as `chat.message` or `party.changed`.

`game.close()` cancels pending requests and closes its transport. Do not share a single owned transport between independently closed clients.

## Configurable social parties

The trusted release manifest chooses `party: {maxMembers: 1..10000}` (default 32 for new parties). `game.party.create({maxMembers: 200})` may select a smaller capacity; the backend rejects values above the release limit and freezes the chosen capacity for that party. A capacity of 10,000 describes stored social membership, not a 10,000-player real-time simulation or automatic push broadcast.

For large groups, create with `{maxMembers: 10000,joinPolicy:"code"}` and privately share the returned `partyId` and `joinCode`. A non-friend can call `party.join({partyId,joinCode})`; membership and capacity checks are still enforced. Default `joinPolicy:"invite"` keeps friend invitations. The 64-hex-character cryptographically random code is a bearer secret and appears only in a leader's party response, never in invitation summaries or ordinary member reads. Do not log it or put it in public URLs. Whoever receives a shared code may join until the party fills or is deleted.

`party.get({partyId?,limit?:1..100,cursor?,inviteCursor?})` returns `{party,invites,inviteCursor}`. A party contains counts (`memberCount`, `inviteCount`, `readyCount`), `maxMembers`, a bounded `members` array, `cursor`, and the caller's `self` row even if it is outside the page. Pass `party.cursor` back as `cursor` to read more members. Pass `inviteCursor` separately to read more invitations; invitation party summaries never include nested rosters. Other party mutations return the first 50 member/invite rows. Pages are live keyset views ordered by game user ID, so membership changes during paging do not form a historical snapshot. Invitations still require the leader to be friends with the target. Party queueing remains separate and unsupported in the current solo matcher.

## Injected transport

```js
window.__ARCANE_GAME_TRANSPORT__ = {
  ready: optionalReadyPromise,
  async request(method, params, { signal, timeoutMs } = {}) { /* JSON result */ },
  subscribe(handler) { /* handler({event,data}) */ return unsubscribe; },
  close() {},
};
```

Only `request` is required. A simple transport may ignore the third argument; the SDK still settles the caller's deadline, ignores late results and never automatically replays it. Cancellation cannot undo a server commit.

## MessageChannel host

The trusted loader supplies:

```js
window.__ARCANE_GAME__ = {
  protocol: "arcane-game-sdk", version: 1,
  hostOrigin: "https://studio.example.com",
  channelId: "host-generated-single-use-channel-id",
};
```

The SDK transfers a MessagePort to `window.parent`, using the exact host origin:

```js
// Window message, transferred port at event.ports[0]
{ type: "arcane:connect", protocolVersion: 1, channelId }
// Host -> port
{ type: "ready", protocolVersion: 1 }
// Game -> port
{ type: "request", id: "rpc-1", method: "storage.read", params: {key:"progress"} }
// Host -> port, exactly one result or error
{ type: "response", id: "rpc-1", result: {item:null} }
{ type: "response", id: "rpc-1", error: {code:"FORBIDDEN",message:"Not allowed",status:403} }
{ type: "event", event: "party.changed", data: {} }
{ type: "close", error: {code:"SESSION_REVOKED",message:"Session ended",status:401} }
```

The host must verify the sending frame's `event.source`, allowed origin, single-use channel ID, registered game/release and capabilities before accepting the port. Channel IDs and message fields alone do not authenticate a publisher. Game code must run on an isolated origin with an appropriate iframe sandbox; this SDK does not provide that sandbox. Handshake timeout or protocol mismatch closes the channel. Late, duplicate and unknown response IDs do not settle a newer request. At most 64 host requests may be pending.

## HTTP gateway

`createHttpTransport({gatewayUrl,gameToken,fetchImpl?,timeoutMs?,maxResponseBytes?})` sends `POST <gatewayUrl>/v1/rpc` with `Authorization: Bearer <scoped gameToken>`, `Content-Type: application/json` and `{method,params}`. Response: `{result: JSON}` or `{error:{code,message,status?,details?}}`. A non-2xx response without a structured error rejects `HTTP_ERROR`; malformed success rejects `INVALID_RESPONSE`. Response size defaults to 1 MiB, including streamed bodies. No HTTP event subscription is implied.

## Match connection

`match.get({matchRunId})` reads an authorized match, including its roster, committed `result` (or `null` until settlement commits) and `state` where an adapter explicitly defines a public schema. The built-in turn-based adapter exposes its public state; private input sequence maps and pending settlement fields are never returned. Finished matches remain readable even when they can no longer issue a new join ticket.

`match.ticket({matchRunId})` returns `{endpoint,ticket,expiresAt,protocol,adapterId,gameUserId,matchRunId}` for an authorized match. The Robo entry flow uses `match.ticket({intent:"entry"})` before its authority assigns a match. Existing engines may use that ticket with their own connection adapter. The optional helper supports `arcane-match-v1`:

```js
const ticket = await game.match.ticket({ matchRunId });
const match = createMatchConnection(ticket);
match.onState(({state,ack,serverTime}) => render(state));
await match.ready; // first valid server state, not just an open TCP connection
match.sendInput({ moveX: 1 }); // returns increasing sequence number
match.close();
```

Wire protocol: join `{type:"join",ticket}`; input `{type:"input",seq,input}`; state `{type:"state",state,ack,serverTime}`; error `{type:"error",error}`. Server ACKs advance the next input sequence, including on resumed connections, and older ACKs never move it backward. A server error with `recoverable:true` emits an error while keeping an already joined match open; authentication and protocol errors still close it. `on("status",...)` and `on("error",...)` are also available. Nonstandard protocols require all three explicit callbacks: `serializeJoin(ticket)`, `serializeInput({seq,input})`, `parseMessage(string)` returning the normalized envelopes above. This lets the existing Robo Rumble wire protocol stay in its game adapter.

Reconnect is off by default. Opt in with `maxReconnectAttempts: 1..10` (`reconnectAttempts` is an alias) and `refreshTicket({signal})`, which must obtain a fresh ticket for the same authorized match. Retries use bounded exponential delays; only consecutive failures count. The helper buffers **zero inputs**: `sendInput` throws while disconnected or above 64 KiB socket backlog, and no previous input or action is replayed after reconnect. The engine supplies a new current movement input after a fresh state. Match sockets do not perform local prediction, reconciliation, matchmaking or game simulation.

## Errors

`new ArcaneError(code,message,status=0,details?)` preserves structured gateway errors. Local codes include `SDK_NOT_CONFIGURED`, `UNSUPPORTED_PROTOCOL`, `INVALID_ARGUMENT`, `SDK_CLOSED`, `ABORTED`, `TIMEOUT`, `TRANSPORT_ERROR`, `INVALID_RESPONSE`, `TOO_MANY_REQUESTS`, `TICKET_EXPIRED`, `MATCH_NOT_READY`, and `BACKPRESSURE`.
