import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { ArcaneGame, createHttpTransport } from "../src/index.js";

async function server(t, handler) {
  const service = http.createServer(handler);
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  t.after(() => { service.closeAllConnections(); service.close(); });
  return `http://127.0.0.1:${service.address().port}`;
}
test("real HTTP gateway gets only scoped Bearer plus exact method/params and preserves conflict errors", async (t) => {
  const calls = [];
  const url = await server(t, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, bearer: req.headers.authorization, cookie: req.headers.cookie, body: JSON.parse(raw) });
    res.setHeader("Content-Type", "application/json");
    if (calls.length === 1) res.end(JSON.stringify({ result: { value: { level: 2 }, version: "v1" } }));
    else { res.statusCode = 409; res.end(JSON.stringify({ error: { code: "VERSION_CONFLICT", message: "Save changed", details: { version: "v2" } } })); }
  });
  const game = await ArcaneGame.connect({ transport: createHttpTransport({ gatewayUrl: url + "/game-gateway/", gameToken: "short-lived-game-token" }) });
  t.after(() => game.close());
  const save = await game.storage.read({ key: "progress" });
  assert.equal(save.value.level, 2);
  await assert.rejects(game.storage.write({ key: "progress", value: 3, expectedVersion: "v1" }), { code: "VERSION_CONFLICT", status: 409 });
  assert.deepEqual(calls[0], { path: "/game-gateway/v1/rpc", bearer: "Bearer short-lived-game-token", cookie: undefined, body: { method: "storage.read", params: { key: "progress" } } });
});

test("HTTP deadlines cover a stalled response body and never retry the operation", async (t) => {
  let writes = 0;
  const url = await server(t, (_req, res) => { writes++; res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"result":'); });
  const transport = createHttpTransport({ gatewayUrl: url, gameToken: "scoped" });
  t.after(() => transport.close());
  await assert.rejects(transport.request("chat.send", { text: "exactly once" }, { timeoutMs: 60 }), { code: "TIMEOUT" });
  assert.equal(writes, 1);
});

test("HTTP refuses malformed success, oversized streamed data and unknown methods", async (t) => {
  let requests = 0;
  const url = await server(t, (_req, res) => {
    requests++;
    res.setHeader("Content-Type", "application/json");
    if (requests === 1) res.end('{"unexpected":true}');
    else { res.write('{"result":"'); res.end("a".repeat(1000) + '"}'); }
  });
  const transport = createHttpTransport({ gatewayUrl: url, gameToken: "scoped", maxResponseBytes: 128 });
  t.after(() => transport.close());
  await assert.rejects(transport.request("context.get"), { code: "INVALID_RESPONSE" });
  await assert.rejects(transport.request("context.get"), { code: "INVALID_RESPONSE" });
  await assert.rejects(transport.request("admin.grant", {}), { code: "INVALID_ARGUMENT" });
  assert.equal(requests, 2);
});

test("HTTP never follows a redirect carrying the game token to another service", async (t) => {
  let leaked = false;
  const target = await server(t, (_req, res) => { leaked = true; res.end('{"result":{}}'); });
  const url = await server(t, (_req, res) => { res.writeHead(307, { Location: target + "/capture" }); res.end(); });
  const transport = createHttpTransport({ gatewayUrl: url, gameToken: "must-not-leak" });
  t.after(() => transport.close());
  await assert.rejects(transport.request("context.get"), { code: "TRANSPORT_ERROR" });
  assert.equal(leaked, false);
  assert.throws(() => createHttpTransport({ gatewayUrl: "http://untrusted.example.com", gameToken: "x" }), { code: "INVALID_ARGUMENT" });
});
