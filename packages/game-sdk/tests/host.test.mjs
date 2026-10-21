import test from "node:test";
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { ArcaneGame, createHostTransport } from "../src/index.js";

const bootstrap = { protocol: "arcane-game-sdk", version: 1, hostOrigin: "https://studio.example.com", channelId: "once-only-channel-123" };
function host(t, handle, { ready = true } = {}) {
  let port, resolveConnected;
  const connected = new Promise((resolve) => { resolveConnected = resolve; });
  const messages = [];
  const window = { MessageChannel, parent: { postMessage(message, origin, ports) {
    messages.push({ message, origin });
    port = ports[0];
    port.addEventListener("message", (event) => handle?.(event.data, port));
    port.start();
    if (ready) port.postMessage({ type: "ready", protocolVersion: 1 });
    resolveConnected(port);
  } } };
  t.after(() => port?.close());
  return { window, messages, connected };
}

test("real MessagePorts handshake to the exact host, correlate out-of-order results and deliver events", async (t) => {
  const requests = [];
  const h = host(t, (packet, port) => {
    if (packet.type !== "request") return;
    requests.push(packet);
    if (requests.length === 2) {
      port.postMessage({ type: "response", id: "nonexistent", result: "spoof" });
      for (const request of [...requests].reverse()) port.postMessage({ type: "response", id: request.id, result: { method: request.method } });
      port.postMessage({ type: "event", event: "chat.message", data: { text: "hello" } });
    }
  });
  const game = await ArcaneGame.connect({ window: h.window, bootstrap });
  t.after(() => game.close());
  let notify;
  const pushed = new Promise((resolve) => { notify = resolve; });
  game.on("chat.message", notify);
  const [profile, inventory] = await Promise.all([game.profile.get(), game.economy.get()]);
  assert.equal(profile.method, "profile.get");
  assert.equal(inventory.method, "economy.get");
  assert.equal((await pushed).text, "hello");
  assert.deepEqual(h.messages, [{ message: { type: "arcane:connect", protocolVersion: 1, channelId: bootstrap.channelId }, origin: bootstrap.hostOrigin }]);
  assert.equal(JSON.stringify(requests).includes("authToken"), false);
});

test("no RPC is sent before ready; a denied capability and host revocation remain errors", async (t) => {
  const requests = [];
  const h = host(t, (packet, port) => {
    requests.push(packet);
    port.postMessage({ type: "response", id: packet.id, error: { code: "FORBIDDEN", message: "No chat capability", status: 403 } });
  }, { ready: false });
  const transport = createHostTransport({ bootstrap, window: h.window });
  t.after(() => transport.close());
  const pending = transport.request("chat.send", { text: "test" });
  const port = await h.connected;
  assert.equal(requests.length, 0);
  port.postMessage({ type: "ready", protocolVersion: 1 });
  await assert.rejects(pending, { code: "FORBIDDEN", status: 403 });
  const stalled = transport.request("storage.read", { key: "save" });
  port.postMessage({ type: "close", error: { code: "SESSION_REVOKED", message: "Session ended", status: 401 } });
  await assert.rejects(stalled, { code: "SESSION_REVOKED" });
});

test("handshake timeout, unsupported host and wildcard origins fail closed", async (t) => {
  const h = host(t, () => {}, { ready: false });
  await assert.rejects(ArcaneGame.connect({ bootstrap, window: h.window, timeoutMs: 30 }), { code: "TIMEOUT" });
  assert.throws(() => createHostTransport({ bootstrap: { ...bootstrap, hostOrigin: "*" }, window: h.window }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => createHostTransport({ bootstrap: { ...bootstrap, version: 9 }, window: h.window }), { code: "UNSUPPORTED_PROTOCOL" });
  const other = host(t, (_packet) => {}, { ready: false });
  const transport = createHostTransport({ bootstrap, window: other.window });
  t.after(() => transport.close());
  (await other.connected).postMessage({ type: "ready", protocolVersion: 8 });
  await assert.rejects(transport.ready, { code: "UNSUPPORTED_PROTOCOL" });
});

test("aborted host requests ignore late responses rather than fulfilling a later call", async (t) => {
  let old;
  const h = host(t, (packet, port) => {
    if (!old) old = packet;
    else {
      port.postMessage({ type: "response", id: old.id, result: { wrong: true } });
      port.postMessage({ type: "response", id: packet.id, result: { current: true } });
    }
  });
  const transport = createHostTransport({ bootstrap, window: h.window });
  await transport.ready;
  t.after(() => transport.close());
  await assert.rejects(transport.request("profile.get", {}, { timeoutMs: 30 }), { code: "TIMEOUT" });
  const next = await transport.request("profile.get");
  assert.equal(next.current, true);
  assert.equal(next.wrong, undefined);
});
