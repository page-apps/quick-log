import {
  appCredentialStorageKey,
  decodeCredentialEnvelope,
  encodeCredentialEnvelope,
  resolveBrowserStorage,
  safeStorageCall,
} from "./storage.js";
import {
  CredentialError,
  type Credential,
  type CredentialProvider,
  type PatProviderOptions,
  type StorageAdapter,
} from "./types.js";

abstract class StoredPatCredentialProvider implements CredentialProvider {
  readonly #appId: string;
  readonly #requestToken: PatProviderOptions["requestToken"];
  readonly #now: () => Date;
  readonly #providedStorage: StorageAdapter | undefined;
  readonly #storageKind: "local" | "session";

  protected constructor(options: PatProviderOptions, storageKind: "local" | "session") {
    this.#appId = options.appId.trim();
    if (!this.#appId) throw new CredentialError("corrupt-storage", "appId must not be empty.");
    this.#requestToken = options.requestToken;
    this.#now = options.now ?? (() => new Date());
    this.#providedStorage = options.storage;
    this.#storageKind = storageKind;
  }

  async connect(): Promise<Credential> {
    const token = normalisePat(await this.#requestToken());
    const credential: Credential = {
      kind: "pat",
      token,
      createdAt: this.#now().toISOString(),
    };
    const storage = this.#storage();
    safeStorageCall(() =>
      storage.setItem(
        appCredentialStorageKey(this.#appId),
        encodeCredentialEnvelope(credential, "app", this.#appId),
      ),
    );
    return credential;
  }

  async get(): Promise<Credential | null> {
    const storage = this.#storage();
    const raw = safeStorageCall(() => storage.getItem(appCredentialStorageKey(this.#appId)));
    if (raw === null) return null;
    try {
      return decodeCredentialEnvelope(raw, { scope: "app", appId: this.#appId });
    } catch (error) {
      // Corrupt or future data must never be handed to a repository client.
      safeStorageCall(() => storage.removeItem(appCredentialStorageKey(this.#appId)));
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const storage = this.#storage();
    safeStorageCall(() => storage.removeItem(appCredentialStorageKey(this.#appId)));
  }

  #storage(): StorageAdapter {
    return this.#providedStorage ?? resolveBrowserStorage(this.#storageKind);
  }
}

/** PAT kept for the current browser tab/session, under an app-specific key. */
export class SessionPatCredentialProvider extends StoredPatCredentialProvider {
  constructor(options: PatProviderOptions) {
    super(options, "session");
  }
}

/** PAT persisted in localStorage under an app-specific, versioned key. */
export class PersistentPatCredentialProvider extends StoredPatCredentialProvider {
  constructor(options: PatProviderOptions) {
    super(options, "local");
  }
}

/** In-memory PAT option for environments where Web Storage should not be used. */
export class MemoryPatCredentialProvider implements CredentialProvider {
  readonly #requestToken: PatProviderOptions["requestToken"];
  readonly #now: () => Date;
  #credential: Credential | null = null;

  constructor(options: Pick<PatProviderOptions, "requestToken" | "now">) {
    this.#requestToken = options.requestToken;
    this.#now = options.now ?? (() => new Date());
  }

  async connect(): Promise<Credential> {
    this.#credential = {
      kind: "pat",
      token: normalisePat(await this.#requestToken()),
      createdAt: this.#now().toISOString(),
    };
    return this.#credential;
  }

  async get(): Promise<Credential | null> {
    return this.#credential;
  }

  async disconnect(): Promise<void> {
    this.#credential = null;
  }
}

function normalisePat(value: string): string {
  const token = value.trim();
  if (!token || /\s/.test(token)) {
    throw new CredentialError("invalid-token", "Enter a non-empty GitHub token without whitespace.");
  }
  return token;
}
