export type CredentialKind = "pat" | "device-flow";

/** A credential is intentionally consumed by framework clients, not app modules. */
export interface Credential {
  readonly kind: CredentialKind;
  readonly token: string;
  readonly createdAt: string;
  readonly account?: string;
}

export interface CredentialProvider {
  connect(): Promise<Credential>;
  get(): Promise<Credential | null>;
  disconnect(options?: { shared?: boolean }): Promise<void>;
}

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type TokenRequest = () => string | Promise<string>;

export interface PatProviderOptions {
  appId: string;
  requestToken: TokenRequest;
  storage?: StorageAdapter;
  now?: () => Date;
}

export class CredentialError extends Error {
  readonly code:
    | "invalid-token"
    | "storage-unavailable"
    | "corrupt-storage"
    | "device-flow-expired"
    | "device-flow-denied"
    | "device-flow-protocol"
    | "network"
    | "not-implemented";

  constructor(
    code: CredentialError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CredentialError";
    this.code = code;
  }
}
