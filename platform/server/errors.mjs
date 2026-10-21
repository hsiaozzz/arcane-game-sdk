export class PlatformError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function assert(condition, code, message, status = 400) {
  if (!condition) throw new PlatformError(code, message, status);
}

export function publicError(error) {
  return error instanceof PlatformError
    ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
    : { code: 'INTERNAL_ERROR', message: '平台服务暂时不可用，请稍后重试。' };
}
