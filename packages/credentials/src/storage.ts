import { CredentialError, type Credential, type StorageAdapter } from "./types.js";

export const CREDENTIAL_ENVELOPE_VERSION = 1 as const;
export const APP_CREDENTIAL_KEY_PREFIX = "repo-apps:app-credentials:v1";
export const SHARED_CREDENTIAL_KEY = "repo-apps:credentials:v1";

export interface CredentialEnvelopeV1 {
  readonly version: 1;
  readonly scope: "app" | "shared";
  readonly appId?: string;
  readonly credential: Credential;
}

export type CredentialEnvelope = CredentialEnvelopeV1;

export function appCredentialStorageKey(appId: string): string {
  const normalised = appId.trim();
  if (!normalised) {
    throw new CredentialError("corrupt-storage", "An app id is required for credential storage.");
  }
  return `${APP_CREDENTIAL_KEY_PREFIX}:${encodeURIComponent(normalised)}`;
}

export function encodeCredentialEnvelope(
  credential: Credential,
  scope: "app" | "shared",
  appId?: string,
): string {
  const envelope: CredentialEnvelopeV1 = {
    version: CREDENTIAL_ENVELOPE_VERSION,
    scope,
    credential,
    ...(appId === undefined ? {} : { appId }),
  };
  return JSON.stringify(envelope);
}

export function decodeCredentialEnvelope(
  raw: string,
  expected: { scope: "app" | "shared"; appId?: string },
): Credential {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new CredentialError("corrupt-storage", "Stored credential data is not valid JSON.", { cause });
  }

  if (!isRecord(value) || value.version !== 1 || value.scope !== expected.scope) {
    throw new CredentialError("corrupt-storage", "Stored credential data has an unsupported format.");
  }
  if (expected.appId !== undefined && value.appId !== expected.appId) {
    throw new CredentialError("corrupt-storage", "Stored credential belongs to a different app.");
  }
  const credential = value.credential;
  if (
    !isRecord(credential) ||
    (credential.kind !== "pat" && credential.kind !== "device-flow") ||
    typeof credential.token !== "string" ||
    !credential.token ||
    typeof credential.createdAt !== "string" ||
    (credential.account !== undefined && typeof credential.account !== "string")
  ) {
    throw new CredentialError("corrupt-storage", "Stored credential is incomplete.");
  }
  return {
    kind: credential.kind,
    token: credential.token,
    createdAt: credential.createdAt,
    ...(credential.account === undefined ? {} : { account: credential.account }),
  };
}

export function safeStorageCall<T>(action: () => T): T {
  try {
    return action();
  } catch (cause) {
    if (cause instanceof CredentialError) throw cause;
    throw new CredentialError(
      "storage-unavailable",
      "Browser credential storage is unavailable. Use a session-only credential instead.",
      { cause },
    );
  }
}

export function resolveBrowserStorage(kind: "local" | "session"): StorageAdapter {
  const storage = kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
  if (!storage) {
    throw new CredentialError(
      "storage-unavailable",
      `${kind === "local" ? "Persistent" : "Session"} browser storage is unavailable.`,
    );
  }
  return storage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
