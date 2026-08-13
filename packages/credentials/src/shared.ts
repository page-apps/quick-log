import { SHARED_CREDENTIAL_KEY, resolveBrowserStorage, safeStorageCall } from "./storage.js";
import {
  CredentialError,
  type Credential,
  type CredentialProvider,
  type StorageAdapter,
  type TokenRequest,
} from "./types.js";

export interface SharedPatCredentialProviderOptions {
  readonly appId: string;
  readonly requestToken: TokenRequest;
  readonly repositoryHint?: string;
  readonly storage?: StorageAdapter;
  readonly now?: () => Date;
}

interface SharedAppRegistration {
  readonly repositoryHint?: string;
  readonly connectedAt: string;
}

export interface SharedCredentialEnvelopeV1 {
  readonly version: 1;
  readonly scope: "shared";
  readonly credential: Credential;
  readonly apps: Readonly<Record<string, SharedAppRegistration>>;
}

export interface SharedCredentialVault extends CredentialProvider {
  readonly storageKey: typeof SHARED_CREDENTIAL_KEY;
  useShared(): Promise<Credential | null>;
  hasShared(): Promise<boolean>;
  hasAppRegistration(): Promise<boolean>;
  listRepositoryHints(): Promise<readonly string[]>;
}

/** Explicit, opt-in shared PAT provider scoped by the browser's same-origin localStorage. */
export class SharedPatCredentialProvider implements SharedCredentialVault {
  readonly storageKey = SHARED_CREDENTIAL_KEY;
  readonly #appId: string;
  readonly #requestToken: TokenRequest;
  readonly #repositoryHint: string | undefined;
  readonly #providedStorage: StorageAdapter | undefined;
  readonly #now: () => Date;
  #enabledForSession = false;

  constructor(options: SharedPatCredentialProviderOptions) {
    this.#appId = options.appId.trim();
    if (!this.#appId) throw new CredentialError("corrupt-storage", "appId must not be empty.");
    this.#requestToken = options.requestToken;
    this.#repositoryHint = options.repositoryHint?.trim() || undefined;
    this.#providedStorage = options.storage;
    this.#now = options.now ?? (() => new Date());
  }

  async connect(): Promise<Credential> {
    const token = normalisePat(await this.#requestToken());
    const credential: Credential = { kind: "pat", token, createdAt: this.#now().toISOString() };
    const current = this.#read(false);
    this.#write({
      version: 1,
      scope: "shared",
      credential,
      apps: { ...(current?.apps ?? {}), [this.#appId]: this.#registration() },
    });
    this.#enabledForSession = true;
    return credential;
  }

  async useShared(): Promise<Credential | null> {
    const envelope = this.#read(true);
    if (!envelope) return null;
    this.#write({
      ...envelope,
      apps: { ...envelope.apps, [this.#appId]: this.#registration() },
    });
    this.#enabledForSession = true;
    return envelope.credential;
  }

  async hasShared(): Promise<boolean> {
    return this.#read(true) !== null;
  }

  async hasAppRegistration(): Promise<boolean> {
    return this.#read(true)?.apps[this.#appId] !== undefined;
  }

  async get(): Promise<Credential | null> {
    if (!this.#enabledForSession) return null;
    return this.#read(true)?.credential ?? null;
  }

  async disconnect(options?: { shared?: boolean }): Promise<void> {
    this.#enabledForSession = false;
    if (options?.shared) safeStorageCall(() => this.#storage().removeItem(this.storageKey));
  }

  async listRepositoryHints(): Promise<readonly string[]> {
    const envelope = this.#read(true);
    if (!envelope) return [];
    return [...new Set(Object.values(envelope.apps).map((app) => app.repositoryHint).filter(isString))].sort();
  }

  #registration(): SharedAppRegistration {
    return {
      connectedAt: this.#now().toISOString(),
      ...(this.#repositoryHint === undefined ? {} : { repositoryHint: this.#repositoryHint }),
    };
  }

  #read(removeInvalid: boolean): SharedCredentialEnvelopeV1 | null {
    const storage = this.#storage();
    const raw = safeStorageCall(() => storage.getItem(this.storageKey));
    if (raw === null) return null;
    try {
      return decodeSharedEnvelope(raw);
    } catch (error) {
      if (removeInvalid) safeStorageCall(() => storage.removeItem(this.storageKey));
      throw error;
    }
  }

  #write(envelope: SharedCredentialEnvelopeV1): void {
    safeStorageCall(() => this.#storage().setItem(this.storageKey, JSON.stringify(envelope)));
  }

  #storage(): StorageAdapter {
    return this.#providedStorage ?? resolveBrowserStorage("local");
  }
}

export function decodeSharedEnvelope(raw: string): SharedCredentialEnvelopeV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new CredentialError("corrupt-storage", "Stored shared credential data is not valid JSON.", { cause });
  }
  if (!isRecord(value) || value.version !== 1 || value.scope !== "shared" || !isRecord(value.credential) || !isRecord(value.apps)) {
    throw new CredentialError("corrupt-storage", "Stored shared credential data has an unsupported format.");
  }
  const credential = value.credential;
  if (credential.kind !== "pat" || typeof credential.token !== "string" || !credential.token || typeof credential.createdAt !== "string") {
    throw new CredentialError("corrupt-storage", "Stored shared credential is incomplete.");
  }
  const apps: Record<string, SharedAppRegistration> = {};
  for (const [appId, registration] of Object.entries(value.apps)) {
    if (!isRecord(registration) || typeof registration.connectedAt !== "string" ||
      (registration.repositoryHint !== undefined && typeof registration.repositoryHint !== "string")) {
      throw new CredentialError("corrupt-storage", "Stored shared credential app metadata is invalid.");
    }
    apps[appId] = {
      connectedAt: registration.connectedAt,
      ...(registration.repositoryHint === undefined ? {} : { repositoryHint: registration.repositoryHint }),
    };
  }
  return {
    version: 1,
    scope: "shared",
    credential: {
      kind: "pat",
      token: credential.token,
      createdAt: credential.createdAt,
      ...(typeof credential.account === "string" ? { account: credential.account } : {}),
    },
    apps,
  };
}

function normalisePat(value: string): string {
  const token = value.trim();
  if (!token || /\s/.test(token)) throw new CredentialError("invalid-token", "Enter a non-empty GitHub token without whitespace.");
  return token;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && Boolean(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
