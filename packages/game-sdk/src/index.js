import { ArcaneError, asArcaneError } from "./errors.js";
import { RPC_METHODS, SDK_VERSION, PROTOCOL_VERSION, deadline, eventName, hasOwn, invalid, jsonCopy, timeoutValue, validateRequest, validateSignal } from "./protocol.js";
import { createHostTransport } from "./transports.js";

export { ArcaneError, SDK_VERSION, PROTOCOL_VERSION, RPC_METHODS };
export { createHttpTransport, createHostTransport } from "./transports.js";
export { createMatchConnection } from "./match.js";

export class ArcaneGame {
  static async connect(options = {}) {
    const hostWindow = options.window ?? globalThis.window;
    const transport = options.transport ?? hostWindow?.__ARCANE_GAME_TRANSPORT__ ?? createHostTransport({
      bootstrap: options.bootstrap ?? hostWindow?.__ARCANE_GAME__, window: hostWindow,
      timeoutMs: options.timeoutMs, signal: options.signal,
    });
    if (!transport || typeof transport.request !== "function") throw invalid("transport.request must be a function.");
    const client = new ArcaneGame(transport, options);
    try {
      await deadline(() => transport.ready, { timeoutMs: client._timeoutMs, signal: options.signal, pending: client._pending });
      if (client._closed) throw new ArcaneError("SDK_CLOSED", "The game platform connection is closed.");
      return client;
    } catch (error) { client.close(); throw asArcaneError(error); }
  }

  constructor(transport, options = {}) {
    if (!transport || typeof transport.request !== "function") throw invalid("Use ArcaneGame.connect() with a configured host or transport.");
    validateSignal(options.signal);
    this._transport = transport;
    this._timeoutMs = timeoutValue(options.timeoutMs);
    this._closed = false;
    this._pending = new Set();
    this._listeners = new Map();
    for (const method of RPC_METHODS) {
      const [namespace, name] = method.split(".");
      if (!hasOwn(this, namespace)) this[namespace] = {};
      this[namespace][name] = (params = {}, requestOptions = {}) => this._request(method, params, requestOptions);
    }
    for (const namespace of new Set(RPC_METHODS.map((name) => name.split(".")[0]))) Object.freeze(this[namespace]);
    this._unsubscribe = typeof transport.subscribe === "function" ? transport.subscribe((event) => this._receive(event)) : null;
  }

  async _request(method, params, options) {
    if (this._closed) throw new ArcaneError("SDK_CLOSED", "The game platform connection is closed.");
    const clean = validateRequest(method, params);
    if (this._pending.size >= 64) throw new ArcaneError("TOO_MANY_REQUESTS", "Too many pending platform requests.", 429);
    try {
      const result = await deadline((signal) => this._transport.request(method, clean, { signal, timeoutMs: timeoutValue(options.timeoutMs, this._timeoutMs) }),
        { signal: options.signal, timeoutMs: timeoutValue(options.timeoutMs, this._timeoutMs), pending: this._pending });
      return result;
    } catch (error) { throw asArcaneError(error); }
  }

  on(name, listener) {
    if (this._closed) throw new ArcaneError("SDK_CLOSED", "The game platform connection is closed.");
    eventName(name);
    if (typeof listener !== "function") throw invalid("The event listener must be a function.");
    const count = [...this._listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
    if (count >= 128) throw invalid("Too many event subscriptions.");
    if (!this._listeners.has(name)) this._listeners.set(name, new Set());
    this._listeners.get(name).add(listener);
    return () => {
      const listeners = this._listeners.get(name);
      listeners?.delete(listener);
      if (!listeners?.size) this._listeners.delete(name);
    };
  }
  _receive(envelope) {
    if (this._closed || !envelope || typeof envelope.event !== "string" || envelope.event === "*") return;
    let data;
    try { eventName(envelope.event); data = jsonCopy(envelope.data ?? null); } catch { return; }
    for (const listener of [...(this._listeners.get(envelope.event) || []), ...(this._listeners.get("*") || [])]) {
      try { listener(data, envelope.event); } catch { /* One game callback cannot interrupt other subscribers. */ }
    }
  }
  close() {
    if (this._closed) return;
    this._closed = true;
    for (const cancel of [...this._pending]) cancel();
    this._listeners.clear();
    try { this._unsubscribe?.(); } catch { /* Closing is idempotent. */ }
    try { this._transport.close?.(); } catch { /* Closing is idempotent. */ }
  }
}
