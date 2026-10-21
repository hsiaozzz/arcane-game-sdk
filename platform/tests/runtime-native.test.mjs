import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const endpoint = process.env.ARCANE_NATIVE_ENDPOINT;
const httpKey = process.env.ARCANE_NATIVE_HTTP_KEY;
const serverKey = process.env.ARCANE_NATIVE_SERVER_KEY;
const adminKey = process.env.ARCANE_NATIVE_ADMIN_KEY;
const gatewayKey = process.env.ARCANE_NATIVE_GATEWAY_KEY;

test("official Nakama Goja HTTP runtime exercises every public method", { skip: !endpoint, timeout: 60000 }, async t => {
  assert.ok(httpKey && serverKey && adminKey && gatewayKey, "Native smoke requires all five endpoint/key environment variables");
  const gameId = "native-" + randomUUID(), environment = "development", releaseId = "r1";
  const manifest = {
    schemaVersion: "1.0", sdkVersion: "0.1",
    capabilities: ["profile", "storage", "friends", "chat", "party", "matchmaking", "match", "leaderboards", "achievements", "economy", "tournaments"],
    multiplayer: { adapter: "turn-based-v1", minPlayers: 2, maxPlayers: 2 },
    leaderboards: { points: { sort: "descending", period: "all_time", writePolicy: "verified_match_result", metric: "points", operator: "sum" } },
    achievements: { winner: { name: "拖把成精", event: "match.won", target: 1, reward: { coins: 25 } } },
    tournaments: { launch: { name: "扫地大赛", startAt: Date.now() - 60000, endAt: Date.now() + 3600000, leaderboardId: "points" } },
  };
  const rpc = async (method, params = {}, user, overrides = {}) => {
    const body = { gatewayKey: method.startsWith("admin.") ? adminKey : gatewayKey, method, params: method.startsWith("admin.") && !["admin.activeMatches", "admin.pendingMatches", "admin.createSession", "admin.getSession", "admin.revokeSession"].includes(method) ? { gameId, environment, releaseId, ...params } : params, context: { gameId, environment, releaseId, platformUserId: user?.id }, ...overrides };
    const response = await fetch(endpoint + "/v2/rpc/arcane_dispatch?http_key=" + encodeURIComponent(httpKey) + "&unwrap=true", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message ?? "Nakama RPC failed"), { code: result.code, status: response.status });
    return result;
  };
  const auth = async () => {
    const response = await fetch(endpoint + "/v2/account/authenticate/custom?create=true", { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(serverKey + ":").toString("base64") }, body: JSON.stringify({ id: "arcane-native-" + randomUUID() }) });
    assert.equal(response.status, 200);
    const { token } = await response.json();
    const account = await fetch(endpoint + "/v2/account", { headers: { authorization: "Bearer " + token } });
    assert.equal(account.status, 200);
    return { id: (await account.json()).user.id, token };
  };
  const reject = (promise, code) => assert.rejects(promise, error => error.code === code);
  const [a, b, c] = await Promise.all([auth(), auth(), auth()]);
  let partyId, matchRunId;
  await t.test("server-only credentials and pending activation are enforced by native Goja", async () => {
    for (const multiplayer of [{ adapter: "turn-based-v1", minPlayers: 2, maxPlayers: 3 }, { adapter: "score-race-v1", minPlayers: 2, maxPlayers: 101 }])
      await reject(rpc("admin.registerGame", { publisherId: "native-owner", buildHash: "test-build", manifest: { ...manifest, multiplayer } }), 3);
    await rpc("admin.registerGame", { publisherId: "native-owner", buildHash: "test-build", manifest, activate: false });
    await reject(rpc("context.get", {}, a), 7);
    await rpc("admin.activateGame", { buildHash: "test-build" });
    assert.equal((await rpc("admin.getGame")).manifest.achievements.winner.name, "拖把成精");
    await reject(rpc("admin.activeMatches", { adapterId: "turn-based-v1" }, a, { gatewayKey }), 7);
    const authenticated = await fetch(endpoint + "/v2/rpc/arcane_dispatch", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + a.token }, body: JSON.stringify(JSON.stringify({ gatewayKey, method: "context.get", context: { gameId, environment, releaseId, platformUserId: a.id }, params: {} })) });
    assert.equal(authenticated.status, 403);
    for (const player of [a, b, c]) player.gameUserId = (await rpc("context.get", {}, player)).gameUserId;
    assert.notEqual(a.gameUserId, a.id); assert.notEqual(a.gameUserId, b.gameUserId);
  });
  await t.test("Chinese profile/save data survives SQL driver text conversion and CAS conflicts", async () => {
    const profile = await rpc("profile.get", {}, a);
    assert.equal((await rpc("profile.update", { expectedVersion: profile.version, displayName: "扫地王🧹", metadata: { slogan: "拖把出击" } }, a)).displayName, "扫地王🧹");
    await reject(rpc("profile.update", { expectedVersion: profile.version, displayName: "迟到" }, a), 6);
    await rpc("storage.write", { key: "save", expectedVersion: 0, value: { greeting: "你好，扫地机器人" } }, a);
    assert.equal((await rpc("storage.read", { key: "save" }, a)).value.greeting, "你好，扫地机器人");
    assert.equal((await rpc("storage.list", {}, a)).items.length, 1);
    await reject(rpc("storage.write", { key: "save", expectedVersion: 0, value: {} }, a), 6);
    assert.equal((await rpc("storage.delete", { key: "save", expectedVersion: 1 }, a)).deleted, true);
  });
  await t.test("friends, private Chinese chat and party permissions work across real sessions", async () => {
    await rpc("friends.request", { gameUserId: b.gameUserId }, a);
    assert.equal((await rpc("friends.list", {}, b)).incoming[0].gameUserId, a.gameUserId);
    await rpc("friends.accept", { gameUserId: a.gameUserId }, b);
    const channelId = (await rpc("chat.channels", {}, a)).channels.find(x => x.type === "dm").channelId;
    await rpc("chat.send", { channelId, text: "你好小拖把🧹" }, a);
    assert.equal((await rpc("chat.history", { channelId }, b)).messages[0].text, "你好小拖把🧹");
    await reject(rpc("chat.history", { channelId }, c), 7);
    partyId = (await rpc("party.create", {}, a)).party.partyId;
    await rpc("party.invite", { partyId, gameUserId: b.gameUserId }, a);
    assert.equal((await rpc("party.get", {}, b)).invites[0].partyId, partyId);
    await rpc("party.accept", { partyId }, b);
    assert.equal((await rpc("party.ready", { partyId, ready: true }, b)).party.members.find(x => x.gameUserId === b.gameUserId).ready, true);
    await rpc("party.leave", { partyId }, a);
    assert.equal((await rpc("party.get", { partyId }, b)).party.leaderId, b.gameUserId);
    await rpc("party.leave", { partyId }, b);
    await rpc("friends.block", { gameUserId: b.gameUserId }, a);
    await reject(rpc("chat.send", { channelId, text: "屏蔽测试" }, b), 7);
    await rpc("friends.remove", { gameUserId: b.gameUserId }, a);
  });
  await t.test("native matchmaking, ticket replay and state recovery retain registered roster", async () => {
    await rpc("matchmaking.join", {}, c);
    assert.equal((await rpc("matchmaking.cancel", {}, c)).cancelled, true);
    assert.equal((await rpc("matchmaking.join", {}, a)).queue.status, "waiting");
    matchRunId = (await rpc("matchmaking.join", {}, b)).queue.matchRunId;
    assert.equal((await rpc("matchmaking.status", {}, a)).queue.matchRunId, matchRunId);
    assert.equal((await rpc("match.get", { matchRunId }, a)).gameUserIds.length, 2);
    await reject(rpc("match.get", { matchRunId }, c), 7);
    const stateParams = { matchRunId, adapterId: "turn-based-v1", expectedVersion: 0, state: { status: "playing", turn: a.gameUserId, deadline: Date.now() + 30000 } };
    assert.equal((await rpc("admin.saveMatchState", stateParams)).stateVersion, 1);
    assert.equal((await rpc("admin.getMatch", { matchRunId })).state.turn, a.gameUserId);
    assert.equal((await rpc("admin.activeMatches", { adapterId: "turn-based-v1", gameId, limit: 1 })).matches[0].matchRunId, matchRunId);
    const admission = { adapterId: "turn-based-v1", gameUserId: a.gameUserId, nonce: randomUUID(), expiresAt: Date.now() + 30000 };
    await rpc("admin.consumeAdmissionTicket", admission); await reject(rpc("admin.consumeAdmissionTicket", admission), 7);
    const ticket = { ...admission, matchRunId, nonce: randomUUID() };
    await rpc("admin.consumeMatchTicket", ticket); await reject(rpc("admin.consumeMatchTicket", ticket), 7);
    await rpc("admin.saveMatchState", { ...stateParams, expectedVersion: 1, state: { status: "finished", stones: 0, winner: a.gameUserId, seqByPlayer: { [a.gameUserId]: 9 }, futureServerSecret: "private-only", pendingResult: { reason: "finished", secret: "private-only" } } });
    assert.equal((await rpc("admin.pendingMatches", { adapterId: "turn-based-v1", gameId })).matches.length, 1);
    const pending = await rpc("match.get", { matchRunId }, a);
    assert.equal(pending.result, null); assert.equal(pending.state.winner, a.gameUserId); assert.equal(pending.state.settlement, "pending");
    assert.equal(JSON.stringify(pending).includes("private-only"), false); assert.equal(pending.state.seqByPlayer, undefined);
  });
  await t.test("trusted idempotent settlement earns ranks, event score and one immutable currency grant", async () => {
    await rpc("tournaments.join", { tournamentId: "launch" }, a);
    assert.equal((await rpc("tournaments.list", {}, a)).tournaments[0].name, "扫地大赛");
    const settlement = { matchRunId, adapterId: "turn-based-v1", reason: "finished", results: [{ gameUserId: a.gameUserId, rank: 1, score: 10, points: 100 }, { gameUserId: b.gameUserId, rank: 2, score: 2, points: 25 }], finishedAt: Date.now() };
    assert.equal((await rpc("admin.settleMatch", settlement)).duplicate, false);
    assert.equal((await rpc("admin.settleMatch", settlement)).duplicate, true);
    assert.equal((await rpc("leaderboards.list", { leaderboardId: "points" }, a)).ownRecord.rank, 1);
    assert.equal((await rpc("tournaments.standings", { tournamentId: "launch" }, a)).ownRecord.score, 100);
    assert.equal((await rpc("achievements.list", {}, a)).achievements[0].completed, true);
    assert.equal((await rpc("achievements.claim", { achievementId: "winner" }, a)).balance, 25);
    assert.equal((await rpc("achievements.claim", { achievementId: "winner" }, a)).duplicate, true);
    assert.equal((await rpc("economy.get", {}, a)).currencies.coins, 25);
    assert.equal((await rpc("admin.activeMatches", { adapterId: "turn-based-v1", gameId })).matches.length, 0);
    const recovered = await rpc("match.get", { matchRunId }, a);
    assert.equal(recovered.state.stones, 0); assert.equal(recovered.state.settlement, "confirmed"); assert.equal(recovered.result.reason, "finished");
    assert.equal(recovered.result.results.find(x => x.gameUserId === a.gameUserId).rank, 1);
    assert.equal(JSON.stringify(recovered).includes(a.id), false); assert.equal(JSON.stringify(recovered).includes("private-only"), false);
    await reject(rpc("match.get", { matchRunId }, c), 7);
    await reject(rpc("economy.grant", { coins: 10000 }, a), 3);
  });
  await t.test("native durable host sessions are revoked server-side", async () => {
    const sessionId = randomUUID();
    await rpc("admin.createSession", { sessionId, platformUserId: a.id, expiresAt: Date.now() + 30000 });
    assert.equal((await rpc("admin.getSession", { sessionId })).revoked, false);
    await rpc("admin.revokeSession", { sessionId }); await reject(rpc("admin.getSession", { sessionId }), 16);
  });
});
