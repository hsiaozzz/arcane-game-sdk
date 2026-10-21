import { ArcaneError, asArcaneError } from "./errors.js";
import { deadline, eventName, hasOwn, invalid, isRecord, jsonCopy, timeoutValue } from "./protocol.js";

/** Optional game socket. Existing engines may keep their own ticket adapter. */
export function createMatchConnection(initialTicket, options = {}) {
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  if (typeof WebSocketImpl !== "function") throw invalid("WebSocket is not available.");
  if (options.reconnectAttempts !== undefined && options.maxReconnectAttempts !== undefined && options.reconnectAttempts !== options.maxReconnectAttempts)
    throw invalid("Use one reconnect limit, or provide matching values.");
  const timeoutMs = timeoutValue(options.timeoutMs), maxRetries = options.maxReconnectAttempts ?? options.reconnectAttempts ?? 0;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw invalid("reconnectAttempts must be between 0 and 10.");
  if (maxRetries && typeof options.refreshTicket !== "function") throw invalid("Reconnect requires refreshTicket to obtain a fresh single-use ticket.");
  const customAdapter = [options.serializeJoin, options.serializeInput, options.parseMessage].every((value) => typeof value === "function");
  if ([options.serializeJoin, options.serializeInput, options.parseMessage].some((value) => value !== undefined) && !customAdapter)
    throw invalid("A custom protocol requires serializeJoin, serializeInput and parseMessage together.");
  const now = options.now ?? Date.now;
  function validateTicket(value) {
    if (!isRecord(value) || typeof value.endpoint !== "string" || typeof value.ticket !== "string" || !value.ticket || value.ticket.length > 16_384)
      throw invalid("A match ticket with endpoint and ticket is required.");
    let url;
    try { url = new URL(value.endpoint); } catch { throw invalid("Invalid match endpoint."); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "wss:" && !(url.protocol === "ws:" && local)) || url.username || url.password || url.search || url.hash)
      throw invalid("Match endpoints require WSS (or WS on localhost), without credentials or query.");
    if (value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt <= now()))
      throw new ArcaneError("TICKET_EXPIRED", "The match ticket has expired.", 401);
    if (value.protocol !== "arcane-match-v1" && !customAdapter) throw invalid("This match protocol requires an explicit engine adapter.");
    return { ...value, endpoint: url.href };
  }
  const serializeJoin = options.serializeJoin ?? ((ticket) => JSON.stringify({ type: "join", ticket: ticket.ticket }));
  const serializeInput = options.serializeInput ?? (({ seq, input }) => JSON.stringify({ type: "input", seq, input }));
  const parseMessage = options.parseMessage ?? ((value) => JSON.parse(value));
  const ticket = validateTicket(initialTicket);
  const listeners = new Map(), cancellations = new Set();
  let closed = false, socket = null, joined = false, sequence = 0, generation = 0, retries = 0, reconnectTimer;
  let readyResolve, readyReject, receivedInitial = false, status = "connecting", attemptReject;
  const initialReady = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  initialReady.catch(() => {});
  const ready = deadline(() => initialReady, { timeoutMs, signal: options.signal, pending: cancellations });
  ready.catch(() => {});
  function emit(name, data) {
    for (const listener of [...(listeners.get(name) || [])]) { try { listener(data); } catch { /* Isolate engine callbacks. */ } }
  }
  function setStatus(value) { status = value; emit("status", { status }); }
  function close() {
    if (closed) return;
    closed = true; joined = false; generation++;
    clearTimeout(reconnectTimer);
    attemptReject?.(new ArcaneError("SDK_CLOSED", "The match connection is closed."));
    readyReject(new ArcaneError("SDK_CLOSED", "The match connection is closed."));
    for (const cancel of [...cancellations]) cancel();
    try { socket?.close(1000, "Game closed"); } catch { /* Socket may be connecting. */ }
    socket = null; setStatus("closed"); listeners.clear();
  }
  function terminal(error) {
    emit("error", asArcaneError(error));
    readyReject(error);
    close();
  }
  function reconnect(error) {
    if (closed) return;
    joined = false;
    if (retries >= maxRetries || !receivedInitial) { terminal(error); return; }
    const delay = Math.min(5000, 250 * 2 ** retries++);
    setStatus("reconnecting");
    reconnectTimer = setTimeout(async () => {
      try {
        const ticket = await deadline((signal) => options.refreshTicket({ signal }), { timeoutMs, pending: cancellations });
        if (!closed) open(validateTicket(ticket));
      } catch (nextError) { if (!closed) reconnect(nextError); }
    }, delay);
  }
  function open(ticket) {
    const current = ++generation;
    let settled = false;
    let resolveAttempt, rejectAttempt;
    const firstState = new Promise((resolve, reject) => { resolveAttempt = resolve; rejectAttempt = reject; });
    attemptReject = rejectAttempt;
    deadline(() => firstState, { timeoutMs, pending: cancellations }).catch((error) => {
      if (closed || generation !== current || settled) return;
      settled = true; generation++;
      try { socket?.close(); } catch { /* Best effort. */ }
      reconnect(error);
    });
    let active;
    try { active = new WebSocketImpl(ticket.endpoint); socket = active; }
    catch (error) { rejectAttempt(error); return; }
    active.addEventListener("open", () => {
      if (closed || generation !== current) return;
      try { active.send(serializeJoin(ticket)); }
      catch (error) { rejectAttempt(error); }
    });
    active.addEventListener("message", (event) => {
      if (closed || generation !== current) return;
      try {
        if (typeof event.data !== "string" || new TextEncoder().encode(event.data).length > 1_048_576) throw new ArcaneError("INVALID_RESPONSE", "Invalid match message.");
        const packet = jsonCopy(parseMessage(event.data), 1_048_576);
        if (!isRecord(packet)) throw new ArcaneError("INVALID_RESPONSE", "Invalid match message.");
        if (packet.type === "error") {
          const error = asArcaneError(packet.error, "MATCH_ERROR");
          const hard = /^(?:UNAUTHORIZED|FORBIDDEN|AUTHENTICATION_REQUIRED|SESSION_REVOKED|TICKET_[A-Z_]+|INVALID_TICKET|PROTOCOL_ERROR|INVALID_RESPONSE)$/.test(error.code);
          if (joined && packet.error?.recoverable === true && !hard) emit("error", error);
          else terminal(error);
          return;
        }
        if (packet.type !== "state") return;
        if (!hasOwn(packet, "state") || (packet.ack !== undefined && (!Number.isSafeInteger(packet.ack) || packet.ack < 0)))
          throw new ArcaneError("INVALID_RESPONSE", "Invalid match state.");
        sequence = Math.max(sequence, packet.ack ?? 0);
        if (!joined) {
          joined = true; receivedInitial = true; retries = 0; settled = true;
          resolveAttempt(); readyResolve(); setStatus("connected");
        }
        emit("state", { state: packet.state, ack: packet.ack ?? null, serverTime: packet.serverTime ?? null });
      } catch (error) { terminal(asArcaneError(error, "INVALID_RESPONSE")); }
    });
    active.addEventListener("error", () => {
      if (closed || generation !== current) return;
      if (!joined) rejectAttempt(new ArcaneError("TRANSPORT_ERROR", "The match connection failed."));
    });
    active.addEventListener("close", () => {
      if (closed || generation !== current) return;
      generation++; rejectAttempt(new ArcaneError("TRANSPORT_ERROR", "The match connection closed."));
      reconnect(new ArcaneError("TRANSPORT_ERROR", "The match connection closed."));
    });
  }
  ready.catch(() => { if (!closed) close(); });
  if (!options.signal?.aborted) open(ticket);
  return {
    ready,
    get status() { return status; },
    sendInput(input) {
      if (closed) throw new ArcaneError("SDK_CLOSED", "The match connection is closed.");
      if (!joined || !socket || socket.readyState !== 1) throw new ArcaneError("MATCH_NOT_READY", "Wait for the match state before sending input.");
      if (!isRecord(input)) throw invalid("Match input must be a plain JSON object.");
      const clean = jsonCopy(input, 16_384);
      if (Number(socket.bufferedAmount || 0) > 65_536) throw new ArcaneError("BACKPRESSURE", "The match socket is busy; this input was not queued.", 429);
      const next = sequence + 1;
      if (!Number.isSafeInteger(next)) throw new ArcaneError("SEQUENCE_EXHAUSTED", "The input sequence needs a new match connection.");
      try { socket.send(serializeInput({ seq: next, input: clean })); }
      catch { throw new ArcaneError("TRANSPORT_ERROR", "The match input could not be sent."); }
      sequence = next;
      return sequence;
    },
    on(name, listener) {
      if (closed) throw new ArcaneError("SDK_CLOSED", "The match connection is closed.");
      eventName(name);
      if (!["state", "status", "error"].includes(name) || typeof listener !== "function") throw invalid("Use state, status or error with a listener.");
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return () => listeners.get(name)?.delete(listener);
    },
    onState(listener) { return this.on("state", listener); },
    close,
  };
}
