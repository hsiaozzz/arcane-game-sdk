import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../nakama/runtime/index.js", import.meta.url), "utf8");
const sqlSource = await readFile(new URL("../nakama/migrations/001_platform.sql", import.meta.url), "utf8");
const user = "bd78efde-00d4-4156-9a51-c37729f4f001";
const adminKey = "admin-unit-test-".padEnd(64, "x");
const gatewayKey = "gateway-unit-test-".padEnd(64, "y");
const context = { gameId: "test-game", environment: "development", releaseId: "r1", platformUserId: user };
const manifest = { schemaVersion: "1.0", sdkVersion: "0.1", capabilities: ["profile", "storage", "matchmaking"], multiplayer: { adapter: "turn-based-v1", minPlayers: 2, maxPlayers: 2, endpoint: "/v1/matches" } };

function harness() {
  const scope = vm.createContext({ JSON, Date, Math, Number, String, Object, Array, RegExp, isFinite, Error });
  vm.runInContext(source, scope);
  const calls = [];
  let result = { gameUserId: "gusr_" + "a".repeat(32) }, registered = true;
  const nk = {
    sqlExec(sql, args) { calls.push({ sql, args }); },
    sqlQuery(sql, args) {
      calls.push({ sql, args });
      if (sql.includes("SELECT r.manifest")) {
        assert.match(sql, /r\.manifest::text AS manifest/);
        return registered ? [{ manifest: JSON.stringify(manifest), active: true, enabled: true }] : [];
      }
      assert.match(sql, /::text AS result/);
      return [{ result: JSON.stringify(result) }];
    },
    usersGetId(ids) { return ids[0] === user ? [{ id: user }] : []; },
  };
  const ctx = { env: { ARCANE_GATEWAY_KEY: gatewayKey, ARCANE_ADMIN_KEY: adminKey } };
  const call = (method, params = {}, overrides = {}, ctxOverrides = {}) => JSON.parse(scope.arcaneDispatch({ ...ctx, ...ctxOverrides }, {}, nk, JSON.stringify({ gatewayKey: method.startsWith("admin.") ? adminKey : gatewayKey, method, context, params, ...overrides })));
  return { scope, nk, ctx, call, calls, setResult(value) { result = value; }, setRegistered(value) { registered = value; } };
}
const failure = (fn, code, message) => assert.throws(fn, error => error.code === code && (!message || error.message === message));

test("generated ES5 entry includes exact SQL migration and registers only a server RPC", () => {
  const h = harness();
  assert.equal(h.scope.ARCANE_MIGRATION, sqlSource);
  const registered = [];
  h.scope.InitModule(h.ctx, { info() {} }, h.nk, { registerRpc(name) { registered.push(name); } });
  assert.deepEqual(registered, ["arcane_dispatch"]);
  assert.match(h.calls[0].sql, /^BEGIN; SELECT pg_advisory_xact_lock/);
  assert.match(h.calls[0].sql, /COMMIT;$/);
  assert.doesNotMatch(source, /\b(?:const|let|class)\s+[A-Za-z_$]|=>|\?\./);
});
test("user-authenticated RPC is denied even with the right secret; admin and gateway keys cannot interchange", () => {
  const h = harness();
  failure(() => h.call("context.get", {}, {}, { userId: user }), 7, "SERVER_ONLY_RPC");
  failure(() => h.call("admin.getGame", { gameId: "test-game", environment: "development" }, { gatewayKey }), 7);
  failure(() => h.call("context.get", {}, { gatewayKey: adminKey }), 7);
  assert.equal(h.calls.length, 0);
});
test("unregistered release, unverified identity and disabled capability fail before business SQL", () => {
  const h = harness();
  h.setRegistered(false); failure(() => h.call("context.get"), 5);
  h.setRegistered(true); failure(() => h.call("context.get", {}, { context: { ...context, platformUserId: "attacker" } }), 16);
  failure(() => h.call("economy.get"), 7, "CAPABILITY_DISABLED");
  assert.equal(h.calls.filter(x => x.sql.startsWith("SELECT arcane_execute")).length, 0);
});
test("gateway context is parameterized and internal UUID does not appear in public identity", () => {
  const h = harness();
  const result = h.call("context.get");
  assert.match(result.gameUserId, /^gusr_/);
  assert.equal(JSON.stringify(result).includes(user), false);
  const query = h.calls.at(-1);
  assert.match(query.sql, /\$1,\$2,\$3,\$4,\$5,\$6::jsonb/);
  assert.deepEqual(Array.from(query.args.slice(0, 5)), [context.gameId, context.environment, context.releaseId, user, "context.get"]);
});
test("save writes/deletes require CAS and UTF-8 size limits", () => {
  const h = harness();
  failure(() => h.call("storage.write", { key: "save", value: {} }), 3, "INVALID_EXPECTED_VERSION");
  failure(() => h.call("storage.delete", { key: "save" }), 3);
  failure(() => h.call("storage.write", { key: "save", expectedVersion: 0, value: "中".repeat(6000) }), 8, "SAVE_VALUE_TOO_LARGE");
  h.call("storage.write", { key: "save", expectedVersion: 0, value: { level: 2 } });
  assert.equal(JSON.parse(h.calls.at(-1).args[5]).collection, "default");
});
test("profiles reject injected attributes and executable avatar URLs", () => {
  const h = harness();
  failure(() => h.call("profile.update", { expectedVersion: 1, gameUserId: "gusr_" + "a".repeat(32) }), 3);
  failure(() => h.call("profile.update", { expectedVersion: 1, avatar: "javascript:alert(1)" }), 3);
  h.call("profile.update", { expectedVersion: 1, displayName: " 小拖把 " });
  assert.equal(JSON.parse(h.calls.at(-1).args[5]).displayName, "小拖把");
});
test("manifest allows only known adapters and server-result scoreboard policies", () => {
  const h = harness();
  const params = { gameId: "demo", environment: "development", releaseId: "r1", publisherId: "owner", buildHash: "hash", manifest: structuredClone(manifest) };
  params.manifest.multiplayer.adapter = "https://untrusted.example/code.js";
  failure(() => h.call("admin.registerGame", params), 3);
  params.manifest.multiplayer.adapter = "unknown-adapter";
  failure(() => h.call("admin.registerGame", params), 7, "ADAPTER_NOT_TRUSTED");
  params.manifest.multiplayer.adapter = "turn-based-v1";
  params.manifest.leaderboards = { score: { sort: "descending", period: "all_time", writePolicy: "client", metric: "score", operator: "sum" } };
  failure(() => h.call("admin.registerGame", params), 3, "INVALID_LEADERBOARD_DEFINITION");
});

test("party capacities and bounded cursors are validated before SQL", () => {
  const h = harness();
  const params = { gameId: "party-bounds", environment: "development", releaseId: "r1", publisherId: "owner", buildHash: "hash", manifest: { ...structuredClone(manifest), party: { maxMembers: 10000 } } };
  h.call("admin.registerGame", params);
  params.manifest.party.maxMembers = 10001;
  failure(() => h.call("admin.registerGame", params), 3, "INVALID_PARTY_MAX_MEMBERS");
  params.manifest.party = { maxMembers: 10000, ignored: true };
  failure(() => h.call("admin.registerGame", params), 3, "UNKNOWN_FIELD_ignored");
  // Call the pure validation helper because this harness manifest has no party capability.
  h.scope.arcaneParams("party.create", { maxMembers: 10000 });
  failure(() => h.scope.arcaneParams("party.create", { maxMembers: 10001 }), 3, "INVALID_PARTY_MAX_MEMBERS");
  h.scope.arcaneParams("party.get", { limit: 100, cursor: "gusr_" + "a".repeat(32), inviteCursor: "p_invite" });
  failure(() => h.scope.arcaneParams("party.get", { limit: 101 }), 3, "INVALID_LIMIT");
  failure(() => h.scope.arcaneParams("party.get", { cursor: "not-a-player" }), 3, "INVALID_GAME_USER_ID");
  h.scope.arcaneParams("party.create", { maxMembers: 10000, joinPolicy: "code" });
  failure(() => h.scope.arcaneParams("party.create", { joinPolicy: "public" }), 3, "INVALID_PARTY_JOIN_POLICY");
  h.scope.arcaneParams("party.join", { partyId: "p_join", joinCode: "a".repeat(64) });
  failure(() => h.scope.arcaneParams("party.join", { partyId: "p_join", joinCode: "short" }), 3, "INVALID_PARTY_JOIN_CODE");
});

test("registered player bounds match each trusted authority's actual room limits", () => {
  const h = harness();
  const params = { gameId: "bounds", environment: "development", releaseId: "r1", publisherId: "owner", buildHash: "hash", manifest: structuredClone(manifest) };
  params.manifest.multiplayer.maxPlayers = 3;
  failure(() => h.call("admin.registerGame", params), 3, "TURN_ADAPTER_REQUIRES_TWO_PLAYERS");
  params.manifest.multiplayer.minPlayers = 3;
  failure(() => h.call("admin.registerGame", params), 3, "TURN_ADAPTER_REQUIRES_TWO_PLAYERS");
  params.manifest.multiplayer = { adapter: "turn-based-v1", minPlayers: 2, maxPlayers: 2 };
  h.call("admin.registerGame", params);
  params.manifest.multiplayer = { adapter: "robo-rumble-authoritative-v1", minPlayers: 2, maxPlayers: 12 };
  h.call("admin.registerGame", params);
  params.manifest.multiplayer.maxPlayers = 13;
  failure(() => h.call("admin.registerGame", params), 3, "ROBO_ADAPTER_PLAYER_LIMIT");
  params.manifest.multiplayer = { adapter: "robo-rumble-authoritative-v1", minPlayers: 1, maxPlayers: 12 };
  failure(() => h.call("admin.registerGame", params), 3, "INVALID_MIN_PLAYERS");
  params.manifest.multiplayer = { adapter: "score-race-v1", minPlayers: 2, maxPlayers: 100 };
  h.call("admin.registerGame", params);
  params.manifest.multiplayer.minPlayers = 100;
  h.call("admin.registerGame", params);
  params.manifest.multiplayer.maxPlayers = 101;
  failure(() => h.call("admin.registerGame", params), 3, "INVALID_MAX_PLAYERS");
});
test("server-only sessions, durable state and admission consumption keep exact context", () => {
  const h = harness();
  h.setResult({ stateVersion: 2 });
  assert.equal(h.call("admin.saveMatchState", { gameId: "demo", environment: "development", releaseId: "r1", adapterId: "turn-based-v1", matchRunId: "match-1", expectedVersion: 1, state: { stones: 9 } }).stateVersion, 2);
  failure(() => h.call("admin.saveMatchState", { gameId: "demo", environment: "development", releaseId: "r1", adapterId: "turn-based-v1", matchRunId: "match-1", expectedVersion: 1, state: { large: "x".repeat(33000) } }), 8);
  h.call("admin.createSession", { sessionId: "session-id-long-enough", platformUserId: user, expiresAt: Date.now() + 30000 });
  const args = h.calls.at(-1).args;
  assert.deepEqual(Array.from(args.slice(0, 4)), ["", "", "", ""]);
});

test("database JSON is cast to text for native Goja and active-match cursors remain server only", () => {
  const h = harness();
  h.setResult({ displayName: "扫地王🧹", metadata: { slogan: "小拖把出击" } });
  assert.equal(h.call("profile.get").displayName, "扫地王🧹");
  h.setResult({ matches: [], cursor: null });
  assert.equal(h.call("admin.activeMatches", { adapterId: "turn-based-v1", limit: 100 }).cursor, null);
  assert.deepEqual(Array.from(h.calls.at(-1).args.slice(0, 4)), ["", "", "", ""]);
  h.call("admin.activeMatches", { adapterId: "turn-based-v1", after: JSON.stringify([123, "game:one", "development", "run:one"]) });
  failure(() => h.call("admin.activeMatches", { adapterId: "turn-based-v1", after: "not-json" }), 3, "INVALID_MATCH_CURSOR");
  failure(() => h.call("admin.activeMatches", { adapterId: "turn-based-v1", after: JSON.stringify([123, "game", "development"]) }), 3, "INVALID_MATCH_CURSOR");
  failure(() => h.call("admin.activeMatches", { adapterId: "turn-based-v1", limit: 101 }), 3);
});
test("runtime rejects unsupported party matchmaking and propagates transactional conflicts", () => {
  const h = harness();
  failure(() => h.call("matchmaking.join", { partyId: "party1" }), 9, "PARTY_MATCHMAKING_UNSUPPORTED");
  h.setResult({ _error: { code: 6, message: "SETTLEMENT_REPLAY_CONFLICT" } });
  failure(() => h.call("context.get"), 6, "SETTLEMENT_REPLAY_CONFLICT");
});
