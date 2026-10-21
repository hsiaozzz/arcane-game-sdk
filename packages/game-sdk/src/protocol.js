import { ArcaneError } from "./errors.js";

export const SDK_VERSION = "0.1.0";
export const PROTOCOL_VERSION = 1;
export const RPC_METHODS = Object.freeze([
  "context.get", "profile.get", "profile.update",
  "storage.read", "storage.write", "storage.delete", "storage.list",
  "friends.list", "friends.request", "friends.accept", "friends.remove", "friends.block",
  "chat.channels", "chat.history", "chat.send",
  "party.create", "party.get", "party.invite", "party.accept", "party.join", "party.leave", "party.ready",
  "matchmaking.join", "matchmaking.status", "matchmaking.cancel", "match.get", "match.ticket",
  "leaderboards.list", "achievements.list", "achievements.claim", "economy.get",
  "tournaments.list", "tournaments.join", "tournaments.standings", "social.open",
]);
const allowedMethods = new Set(RPC_METHODS);
export const MAX_MESSAGE_BYTES = 65_536;
export const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function invalid(message) { return new ArcaneError("INVALID_ARGUMENT", message, 400); }
export function timeoutValue(value, fallback = 10_000) {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < 1 || result > 120_000) throw invalid("timeoutMs must be between 1 and 120000.");
  return result;
}
export function validateSignal(signal) {
  if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function"))
    throw invalid("signal must be an AbortSignal.");
}
export function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
export function jsonCopy(value, limit = MAX_MESSAGE_BYTES) {
  const ancestors = new Set();
  let nodes = 0;
  function copy(item, depth) {
    if (++nodes > 10_000 || depth > 24) throw invalid("JSON data is too deeply nested or contains too many values.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || (!Array.isArray(item) && !isRecord(item))) throw invalid("Only plain JSON data is supported.");
    if (ancestors.has(item)) throw invalid("JSON data must not contain cycles.");
    ancestors.add(item);
    const array = Array.isArray(item);
    if (array && (item.length > 10_000 || Object.keys(item).length !== item.length || Object.keys(item).some((key, index) => key !== String(index))))
      throw invalid("JSON arrays must be dense and contain at most 10000 values.");
    const result = array ? [] : Object.create(null);
    if (Object.getOwnPropertySymbols(item).length) throw invalid("JSON data must not contain symbol keys.");
    for (const key of Object.keys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !hasOwn(descriptor, "value")) throw invalid("JSON data must not contain getters or setters.");
      result[key] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
    return result;
  }
  const result = copy(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > limit) throw invalid("JSON data exceeds the message size limit.");
  return result;
}
export function validateRequest(method, params = {}) {
  if (!allowedMethods.has(method)) throw invalid("Unknown game platform method.");
  if (!isRecord(params)) throw invalid("Method parameters must be a plain JSON object.");
  const clean = jsonCopy(params);
  if (new TextEncoder().encode(JSON.stringify({ method, params: clean })).length > MAX_MESSAGE_BYTES)
    throw invalid("RPC request exceeds the message size limit.");
  return clean;
}
export function eventName(value) {
  if (typeof value !== "string" || !/^(?:\*|[A-Za-z][A-Za-z0-9:._-]{0,95})$/.test(value)) throw invalid("Invalid event name.");
  return value;
}

/** An abortable deadline also settles when an injected transport ignores abort. */
export function deadline(operation, { signal, timeoutMs = 10_000, pending } = {}) {
  validateSignal(signal);
  timeoutMs = timeoutValue(timeoutMs);
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false, timer;
    const finish = (failed, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      pending?.delete(cancel);
      if (failed) { controller.abort(); reject(value); } else resolve(value);
    };
    const abort = () => finish(true, new ArcaneError("ABORTED", "The request was aborted."));
    const cancel = (reason) => finish(true, reason instanceof Error ? reason : new ArcaneError("SDK_CLOSED", "The game platform connection is closed."));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    pending?.add(cancel);
    timer = setTimeout(() => finish(true, new ArcaneError("TIMEOUT", "The game platform request timed out.", 408)), timeoutMs);
    Promise.resolve().then(() => { if (!settled) return operation(controller.signal); }).then((result) => finish(false, result), (error) => finish(true, error));
  });
}
