// Custom error classes for Cine Colombia CLI

export class CineError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'CineError';
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

/** Network-level failure: DNS, timeout, connection reset. */
export class NetworkError extends CineError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, details);
    this.name = 'NetworkError';
  }
}

/**
 * The auth token could not be obtained or was rejected.
 *
 * The most common cause is Cloudflare serving an interactive challenge instead
 * of the page that carries the token, which no plain HTTP client can solve.
 */
export class AuthError extends CineError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, details);
    this.name = 'AuthError';
  }
}

/** OCAPI responded with a non-success status. */
export class ApiError extends CineError {
  constructor(
    code: string,
    message: string,
    public status: number,
    details?: unknown
  ) {
    super(code, message, details);
    this.name = 'ApiError';
  }
}

/** A response did not match the shape we expect. */
export class ValidationError extends CineError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends CineError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, details);
    this.name = 'NotFoundError';
  }
}

export class CacheError extends CineError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, details);
    this.name = 'CacheError';
  }
}
