import test from "node:test";
import assert from "node:assert/strict";
import { ArcaneGame, ArcaneError } from "../src/index.js";

test("a generated page without a host fails clearly and never authenticates", async () => {
  await assert.rejects(ArcaneGame.connect({ window: {} }), { code: "SDK_NOT_CONFIGURED" });
  const calls = [];
  const game = await ArcaneGame.connect({ window: { __ARCANE_GAME_TRANSPORT__: { request: async (...args) => calls.push(args) } } });
  assert.equal(calls.length, 0, "connection must not create an account or call any RPC");
  game.close();
});

test("game methods preserve the gateway contract and snapshot params before asynchronous dispatch", async () => {
  const calls = [];
  const game = await ArcaneGame.connect({ transport: { request: async (method, params) => {
    calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
    return method === "match.ticket" ? { endpoint: "wss://match.example.com/ws", ticket: "scoped", protocol: "arcane-match-v1" } : { accepted: true };
  } } });
  const params = { key: "progress", value: { level: 3 }, expectedVersion: "v1" };
  const save = game.storage.write(params);
  params.value.level = 99;
  await save;
  await game.party.ready({ ready: true });
  await game.achievements.claim({ achievementId: "first-win", proof: "event-42" });
  await game.economy.get();
  await game.tournaments.join({ tournamentId: "weekly" });
  await game.social.open({ view: "friends" });
  await game.match.get({ matchRunId: "match-1" });
  const ticket = await game.match.ticket({ matchRunId: "match-1" });
  assert.deepEqual(calls[0], { method: "storage.write", params: { key: "progress", value: { level: 3 }, expectedVersion: "v1" } });
  assert.deepEqual(calls.slice(1).map((call) => call.method), ["party.ready", "achievements.claim", "economy.get", "tournaments.join", "social.open", "match.get", "match.ticket"]);
  assert.equal(ticket.ticket, "scoped");
  assert.equal(game.match.settle, undefined);
  assert.equal(game.economy.grant, undefined);
  game.close();
});

test("malformed, cyclic, sparse and oversized data never reaches a transport", async () => {
  let calls = 0;
  const game = await ArcaneGame.connect({ transport: { request: async () => { calls++; } } });
  const cyclic = {}; cyclic.self = cyclic;
  const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("must not run"); } });
  for (const params of [null, [], { n: Infinity }, { n: 1n }, { value: new Date() }, { cyclic }, accessor, { value: new Array(3) }, { value: "🤖".repeat(20_000) }])
    await assert.rejects(game.storage.write(params), { code: "INVALID_ARGUMENT" });
  assert.equal(calls, 0);
  game.close();
});

test("timeout does not retry a possibly committed mutation and later completion is ignored", async () => {
  let calls = 0, complete;
  const game = await ArcaneGame.connect({ transport: { request: () => { calls++; return new Promise((resolve) => { complete = resolve; }); } } });
  await assert.rejects(game.chat.send({ channelId: "lobby", text: "one message" }, { timeoutMs: 25 }), { code: "TIMEOUT" });
  complete({ sent: true });
  await Promise.resolve();
  assert.equal(calls, 1);
  game.close();
});

test("abort and close settle even when an injected transport ignores cancellation", async () => {
  let closeCount = 0;
  const game = await ArcaneGame.connect({ transport: { request: () => new Promise(() => {}), close() { closeCount++; } } });
  const controller = new AbortController();
  const aborted = game.storage.read({ key: "x" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, { code: "ABORTED" });
  const pending = game.party.get();
  game.close(); game.close();
  await assert.rejects(pending, { code: "SDK_CLOSED" });
  await assert.rejects(game.profile.get(), { code: "SDK_CLOSED" });
  assert.equal(closeCount, 1);
});

test("events unsubscribe, isolate listeners, and stop after client close", async () => {
  let receive, unsubscribed = 0;
  const game = await ArcaneGame.connect({ transport: { request: async () => null, subscribe(listener) { receive = listener; return () => { unsubscribed++; }; } } });
  const events = [];
  game.on("party.changed", () => { throw new Error("game callback"); });
  const off = game.on("party.changed", (data) => events.push(data.members));
  game.on("*", (_data, name) => events.push(name));
  receive({ event: "party.changed", data: { members: 2 } });
  off();
  receive({ event: "party.changed", data: { members: 3 } });
  receive({ event: "invalid event", data: {} });
  game.close();
  receive({ event: "party.changed", data: { members: 4 } });
  assert.deepEqual(events, [2, "party.changed", "party.changed"]);
  assert.equal(unsubscribed, 1);
});

test("structured gateway errors retain their code, status and details", async () => {
  const game = await ArcaneGame.connect({ transport: { request: async () => { throw { code: "VERSION_CONFLICT", message: "Reload save", status: 409, details: { currentVersion: "v2" } }; } } });
  await assert.rejects(game.storage.write({ key: "save", value: 1 }), (error) => {
    assert.ok(error instanceof ArcaneError);
    assert.equal(error.code, "VERSION_CONFLICT");
    assert.equal(error.status, 409);
    assert.equal(error.details.currentVersion, "v2");
    return true;
  });
  game.close();
});
