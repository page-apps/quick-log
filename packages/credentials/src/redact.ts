const TOKEN_PATTERNS = [
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~-]+\b/gi,
] as const;

export const REDACTED_TOKEN = "[REDACTED]";

/** Removes common GitHub token forms from diagnostics before logging or display. */
export function redactSecrets(value: string): string {
  return TOKEN_PATTERNS.reduce((result, pattern) => result.replace(pattern, REDACTED_TOKEN), value);
}

export function credentialSummary(credential: { kind: string; account?: string }): string {
  return credential.account ? `${credential.kind} for ${credential.account}` : `${credential.kind} credential`;
}
