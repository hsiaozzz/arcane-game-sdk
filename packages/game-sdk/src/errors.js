export class ArcaneError extends Error {
  constructor(code, message, status = 0, details) {
    super(message);
    this.name = "ArcaneError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export function asArcaneError(error, fallback = "TRANSPORT_ERROR", status = 0) {
  if (error instanceof ArcaneError) return error;
  if (error && typeof error.code === "string" && typeof error.message === "string")
    return new ArcaneError(error.code, error.message, Number.isInteger(error.status) ? error.status : status, error.details);
  return new ArcaneError(fallback, fallback === "TRANSPORT_ERROR" ? "The game platform could not be reached." : "The game platform returned an invalid response.", status);
}
