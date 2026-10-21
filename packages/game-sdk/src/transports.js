import { ArcaneError, asArcaneError } from "./errors.js";
import { PROTOCOL_VERSION, deadline, eventName, hasOwn, invalid, isRecord, jsonCopy, timeoutValue, validateRequest, validateSignal } from "./protocol.js";

const closedError = () => new ArcaneError("SDK_CLOSED", "The game platform connection is closed.");
const responseError = () => new ArcaneError("INVALID_RESPONSE", "The game platform returned an invalid response.");

function trustedUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw invalid(`${label} must be an absolute URL.`); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash)
    throw invalid(`${label} requires HTTPS (or HTTP on localhost), without credentials, query or fragment.`);
  return url;
}

/** This token must already be scoped by the trusted platform; this never logs in. */
export function createHttpTransport({ gatewayUrl, gameToken, fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs, maxResponseBytes = 1_048_576 } = {}) {
  const base = trustedUrl(gatewayUrl, "gatewayUrl");
  if (typeof gameToken !== "string" || !gameToken || gameToken.length > 16_384 || /[\r\n]/.test(gameToken)) throw invalid("A scoped gameToken is required.");
  if (typeof fetchImpl !== "function") throw invalid("fetch is not available.");
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 4_194_304) throw invalid("Invalid response size limit.");
  const rpcUrl = base.href.replace(/\/$/, "") + "/v1/rpc";
  const defaultTimeout = timeoutValue(timeoutMs);
  const pending = new Set();
  let closed = false;
  return {
    async request(method, params = {}, options = {}) {
      if (closed) throw closedError();
      const clean = validateRequest(method, params);
      if (pending.size >= 64) throw new ArcaneError("TOO_MANY_REQUESTS", "Too many pending platform requests.", 429);
      try {
        return await deadline(async (signal) => {
          const response = await fetchImpl(rpcUrl, {
            method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal,
            headers: { Authorization: `Bearer ${gameToken}`, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ method, params: clean }),
          });
          if (!response || typeof response.status !== "number" || typeof response.text !== "function") throw responseError();
          if (Number(response.headers?.get?.("content-length")) > maxResponseBytes) throw responseError();
          let raw;
          if (response.body?.getReader) {
            const reader = response.body.getReader(), decoder = new TextDecoder();
            const parts = [];
            let length = 0;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                length += value.byteLength;
                if (length > maxResponseBytes) throw responseError();
                parts.push(decoder.decode(value, { stream: true }));
              }
              parts.push(decoder.decode());
              raw = parts.join("");
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock?.(); }
          } else {
            raw = await response.text();
            if (new TextEncoder().encode(raw).length > maxResponseBytes) throw responseError();
          }
          let body;
          try { body = JSON.parse(raw); } catch { throw responseError(); }
          if (!isRecord(body)) throw responseError();
          if (isRecord(body.error)) throw asArcaneError(body.error, "INVALID_RESPONSE", response.status);
          if (!response.ok) throw new ArcaneError("HTTP_ERROR", "The game platform rejected the request.", response.status);
          if (!hasOwn(body, "result")) throw responseError();
          return body.result;
        }, { signal: options.signal, timeoutMs: timeoutValue(options.timeoutMs, defaultTimeout), pending });
      } catch (error) { throw asArcaneError(error); }
    },
    subscribe() { return () => {}; },
    close() {
      if (closed) return;
      closed = true;
      for (const cancel of [...pending]) cancel();
    },
  };
}

/** A transferred port is the capability. No platform login tokens enter the frame. */
export function createHostTransport({ bootstrap, window: hostWindow = globalThis.window, MessageChannelImpl = hostWindow?.MessageChannel ?? globalThis.MessageChannel, timeoutMs, signal } = {}) {
  if (!bootstrap) throw new ArcaneError("SDK_NOT_CONFIGURED", "This game needs an Arcane host or an explicitly configured scoped transport.");
  if (!isRecord(bootstrap) || bootstrap.protocol !== "arcane-game-sdk" || bootstrap.version !== PROTOCOL_VERSION)
    throw new ArcaneError("UNSUPPORTED_PROTOCOL", "The host SDK protocol is not supported.");
  const origin = trustedUrl(bootstrap.hostOrigin, "hostOrigin");
  if (origin.pathname !== "/" || origin.origin !== bootstrap.hostOrigin.replace(/\/$/, "")) throw invalid("hostOrigin must contain only a URL origin.");
  if (typeof bootstrap.channelId !== "string" || !/^[A-Za-z0-9_-]{8,160}$/.test(bootstrap.channelId)) throw invalid("Invalid host channelId.");
  if (!hostWindow?.parent || hostWindow.parent === hostWindow || typeof hostWindow.parent.postMessage !== "function" || typeof MessageChannelImpl !== "function")
    throw new ArcaneError("SDK_NOT_CONFIGURED", "A trusted parent frame and MessageChannel are required.");
  validateSignal(signal);
  const defaultTimeout = timeoutValue(timeoutMs), channel = new MessageChannelImpl(), port = channel.port1;
  const requests = new Map(), listeners = new Set(), cancellations = new Set();
  let nextId = 0, inflight = 0, closed = false, ready = false, readyResolve, readyReject;
  const handshake = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  handshake.catch(() => {});
  const notify = (event) => {
    for (const listener of [...listeners]) { try { listener(event); } catch { /* Isolate callbacks. */ } }
  };
  function stop(error = closedError()) {
    if (closed) return;
    closed = true;
    readyReject(error);
    for (const request of requests.values()) request.reject(error);
    requests.clear();
    for (const cancel of [...cancellations]) cancel(error);
    port.removeEventListener?.("message", receive);
    port.removeEventListener?.("messageerror", failed);
    try { port.close(); channel.port2.close(); } catch { /* The other endpoint may have closed. */ }
    notify({ event: "transport.closed", data: { code: error.code } });
    listeners.clear();
  }
  function failed() { stop(new ArcaneError("TRANSPORT_ERROR", "The host message channel failed.")); }
  function receive(message) {
    if (closed) return;
    let packet;
    try { packet = jsonCopy(message.data, 1_048_576); } catch { stop(responseError()); return; }
    if (!isRecord(packet)) { stop(responseError()); return; }
    if (packet.type === "ready") {
      if (packet.protocolVersion !== PROTOCOL_VERSION) { stop(new ArcaneError("UNSUPPORTED_PROTOCOL", "The host SDK protocol is not supported.")); return; }
      if (!ready) { ready = true; readyResolve(); }
    } else if (packet.type === "close") stop(asArcaneError(packet.error ?? closedError()));
    else if (ready && packet.type === "response" && typeof packet.id === "string") {
      const pending = requests.get(packet.id);
      if (!pending) return;
      requests.delete(packet.id);
      if (hasOwn(packet, "error")) pending.reject(asArcaneError(packet.error, "INVALID_RESPONSE"));
      else if (hasOwn(packet, "result")) pending.resolve(packet.result);
      else pending.reject(responseError());
    } else if (ready && packet.type === "event" && typeof packet.event === "string") {
      try { eventName(packet.event); } catch { return; }
      notify({ event: packet.event, data: packet.data ?? null });
    }
  }
  port.addEventListener("message", receive);
  port.addEventListener("messageerror", failed);
  port.start();
  const readyPromise = deadline(() => handshake, { signal, timeoutMs: defaultTimeout, pending: cancellations }).catch((error) => { stop(error); throw error; });
  // Creating a transport without immediately awaiting `ready` must not leak a rejection.
  readyPromise.catch(() => {});
  try {
    hostWindow.parent.postMessage({ type: "arcane:connect", protocolVersion: PROTOCOL_VERSION, channelId: bootstrap.channelId }, origin.origin, [channel.port2]);
  } catch { stop(new ArcaneError("TRANSPORT_ERROR", "The host handshake could not be sent.")); }
  return {
    ready: readyPromise,
    async request(method, params = {}, options = {}) {
      if (closed) throw closedError();
      const clean = validateRequest(method, params);
      if (inflight >= 64) throw new ArcaneError("TOO_MANY_REQUESTS", "Too many pending platform requests.", 429);
      inflight++;
      const id = `rpc-${++nextId}`;
      try {
        return await deadline(async (requestSignal) => {
          await readyPromise;
          if (closed) throw closedError();
          if (requestSignal.aborted) throw new ArcaneError("ABORTED", "The request was aborted.");
          return new Promise((resolve, reject) => {
            requests.set(id, { resolve, reject });
            try { port.postMessage({ type: "request", id, method, params: clean }); }
            catch { requests.delete(id); reject(new ArcaneError("TRANSPORT_ERROR", "The host request could not be sent.")); }
          });
        }, { signal: options.signal, timeoutMs: timeoutValue(options.timeoutMs, defaultTimeout), pending: cancellations });
      } catch (error) { throw asArcaneError(error); }
      finally { inflight--; requests.delete(id); }
    },
    subscribe(listener) {
      if (closed) throw closedError();
      if (typeof listener !== "function") throw invalid("The event listener must be a function.");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() { stop(); },
  };
}
