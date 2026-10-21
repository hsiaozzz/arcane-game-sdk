import test from "node:test";
import assert from "node:assert/strict";
import { createMatchConnection } from "../src/index.js";

const ticket = { endpoint: "wss://matches.example.com/ws", ticket: "single-use-1", protocol: "arcane-match-v1", expiresAt: Date.now() + 120_000 };
function sockets() {
  const instances = [], waiting = [];
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; this.bufferedAmount = 0; instances.push(this); waiting.shift()?.(this); }
    send(value) { if (this.readyState !== 1) throw new Error("closed"); this.sent.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    message(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  return { Socket, instances, next: () => new Promise((resolve) => waiting.push(resolve)) };
}
test("match joins with only its ticket, waits for authority, sequences input and bounds backlog", async (t) => {
  const fake = sockets();
  const match = createMatchConnection(ticket, { WebSocketImpl: fake.Socket });
  t.after(() => match.close());
  const socket = fake.instances[0], states = [];
  match.onState((state) => states.push(state));
  assert.throws(() => match.sendInput({ moveX: 1 }), { code: "MATCH_NOT_READY" });
  socket.open();
  assert.deepEqual(socket.sent, [{ type: "join", ticket: ticket.ticket }]);
  assert.throws(() => match.sendInput({ moveX: 1 }), { code: "MATCH_NOT_READY" });
  socket.message({ type: "state", state: { x: 0 }, ack: 0, serverTime: 10 });
  await match.ready;
  assert.equal(match.sendInput({ moveX: 1 }), 1);
  assert.equal(match.sendInput({ moveX: 0 }), 2);
  socket.bufferedAmount = 65_537;
  assert.throws(() => match.sendInput({ moveX: 1 }), { code: "BACKPRESSURE" });
  assert.equal(socket.sent.length, 3);
  assert.equal(states[0].state.x, 0);
});

test("reconnect requires a fresh ticket and replays zero old or disconnected inputs", async (t) => {
  const fake = sockets();
  let refreshes = 0;
  const match = createMatchConnection(ticket, { WebSocketImpl: fake.Socket, maxReconnectAttempts: 1,
    refreshTicket: async () => { refreshes++; return { ...ticket, ticket: "single-use-2" }; } });
  t.after(() => match.close());
  const first = fake.instances[0]; first.open(); first.message({ type: "state", state: {}, ack: 0 }); await match.ready;
  match.sendInput({ action: "throw-once" });
  const nextSocket = fake.next();
  first.close();
  assert.throws(() => match.sendInput({ action: "do-not-queue" }), { code: "MATCH_NOT_READY" });
  const next = await nextSocket;
  next.open(); next.message({ type: "state", state: {}, ack: 1 });
  assert.equal(refreshes, 1);
  assert.deepEqual(next.sent, [{ type: "join", ticket: "single-use-2" }]);
  assert.equal(match.sendInput({ moveX: 0 }), 2);
  assert.deepEqual(next.sent[1], { type: "input", seq: 2, input: { moveX: 0 } });
});

test("unknown protocols cannot silently send a wrong handshake; explicit Robo adapter preserves envelopes", async (t) => {
  const fake = sockets();
  assert.throws(() => createMatchConnection({ ...ticket, protocol: "robo-v2" }, { WebSocketImpl: fake.Socket }), { code: "INVALID_ARGUMENT" });
  assert.equal(fake.instances.length, 0);
  const match = createMatchConnection({ ...ticket, protocol: "robo-v2" }, { WebSocketImpl: fake.Socket,
    serializeJoin: (value) => JSON.stringify({ type: "rejoin", ticket: value.ticket, code: "ABCDEF" }),
    serializeInput: ({ seq, input }) => JSON.stringify({ type: "input", seq, ...input }),
    parseMessage: (raw) => { const packet = JSON.parse(raw); return { type: "state", state: packet.snapshot, ack: packet.snapshot.inputAck }; },
  });
  t.after(() => match.close());
  const socket = fake.instances[0]; socket.open(); socket.message({ type: "welcome", snapshot: { inputAck: 0, x: 3 } });
  await match.ready;
  match.sendInput({ x: 1, boost: false });
  assert.deepEqual(socket.sent[0], { type: "rejoin", ticket: ticket.ticket, code: "ABCDEF" });
  assert.deepEqual(socket.sent[1], { type: "input", seq: 1, x: 1, boost: false });
});

test("expired tickets and aborted connections cannot open a socket", async () => {
  const fake = sockets();
  assert.throws(() => createMatchConnection({ ...ticket, expiresAt: 0 }, { WebSocketImpl: fake.Socket }), { code: "TICKET_EXPIRED" });
  const controller = new AbortController(); controller.abort();
  const match = createMatchConnection(ticket, { WebSocketImpl: fake.Socket, signal: controller.signal });
  await assert.rejects(match.ready, { code: "ABORTED" });
  assert.equal(fake.instances.length, 0);
});

test("a resumed match advances input past server acknowledgements and ignores older ACKs", async (t) => {
  const fake = sockets(), match = createMatchConnection(ticket, { WebSocketImpl: fake.Socket });
  t.after(() => match.close());
  const socket = fake.instances[0]; socket.open();
  socket.message({ type: "state", state: { resumed: true }, ack: 80 });
  await match.ready;
  assert.equal(match.sendInput({ moveX: 1 }), 81);
  socket.message({ type: "state", state: {}, ack: 79 });
  assert.equal(match.sendInput({ moveX: 0 }), 82);
});

test("recoverable move rejection preserves the match while authentication rejection closes it", async (t) => {
  const fake = sockets(), match = createMatchConnection(ticket, { WebSocketImpl: fake.Socket });
  t.after(() => match.close());
  const errors = []; match.on("error", (error) => errors.push(error.code));
  const socket = fake.instances[0]; socket.open(); socket.message({ type: "state", state: {}, ack: 0 }); await match.ready;
  socket.message({ type: "error", error: { code: "INVALID_MOVE", message: "Not your turn", recoverable: true } });
  assert.equal(match.status, "connected");
  assert.equal(match.sendInput({ cell: 3 }), 1);
  socket.message({ type: "error", error: { code: "TICKET_EXPIRED", message: "Ticket expired", recoverable: true } });
  assert.equal(match.status, "closed");
  assert.deepEqual(errors, ["INVALID_MOVE", "TICKET_EXPIRED"]);
});
