import type { FetchResponse } from "./types.js";

export type RepositoryErrorCode =
  | "authentication"
  | "permission"
  | "not-found"
  | "validation"
  | "conflict"
  | "rate-limit"
  | "network"
  | "unsupported"
  | "invalid-response";

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;
  readonly status?: number;
  readonly retryAt?: Date;

  constructor(
    code: RepositoryErrorCode,
    message: string,
    options?: ErrorOptions & { status?: number; retryAt?: Date },
  ) {
    super(message, options);
    this.name = "RepositoryError";
    this.code = code;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAt !== undefined) this.retryAt = options.retryAt;
  }
}

export class AuthenticationError extends RepositoryError {
  constructor(status = 401) {
    super("authentication", "Connect a valid GitHub credential and try again.", { status });
    this.name = "AuthenticationError";
  }
}

export class PermissionError extends RepositoryError {
  constructor(status = 403) {
    super("permission", "The credential cannot access the configured repository with the required permission.", { status });
    this.name = "PermissionError";
  }
}

export class ConflictError extends RepositoryError {
  readonly expectedSha?: string;
  constructor(expectedSha?: string, status = 409) {
    super("conflict", "The remote file changed. Reload it before saving or explicitly resolve the conflict.", { status });
    this.name = "ConflictError";
    if (expectedSha !== undefined) this.expectedSha = expectedSha;
  }
}

export class RateLimitError extends RepositoryError {
  constructor(retryAt?: Date, status = 403) {
    super("rate-limit", "GitHub API rate limit reached. Wait before trying again.", {
      status,
      ...(retryAt === undefined ? {} : { retryAt }),
    });
    this.name = "RateLimitError";
  }
}

export class ValidationError extends RepositoryError {
  constructor(message: string, status?: number) {
    super("validation", message, status === undefined ? undefined : { status });
    this.name = "ValidationError";
  }
}

export class UnsupportedOperationError extends RepositoryError {
  constructor(operation: string) {
    super("unsupported", `${operation} is not supported by this repository client.`);
    this.name = "UnsupportedOperationError";
  }
}

export function errorForResponse(response: FetchResponse, expectedSha?: string): RepositoryError {
  if (response.status === 401) return new AuthenticationError(response.status);
  if (response.status === 403) {
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = response.headers.get("x-ratelimit-reset");
      const retryAt = reset && /^\d+$/.test(reset) ? new Date(Number(reset) * 1000) : undefined;
      return new RateLimitError(retryAt, response.status);
    }
    return new PermissionError(response.status);
  }
  if (response.status === 404) {
    return new RepositoryError("not-found", "The requested repository resource was not found.", { status: 404 });
  }
  if (response.status === 409 || (response.status === 422 && expectedSha !== undefined)) {
    return new ConflictError(expectedSha, response.status);
  }
  if (response.status === 422) {
    return new ValidationError("GitHub rejected the repository operation as invalid.", response.status);
  }
  return new RepositoryError("invalid-response", `GitHub API request failed with status ${response.status}.`, {
    status: response.status,
  });
}
