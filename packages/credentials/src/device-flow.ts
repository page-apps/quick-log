import { CredentialError, type Credential, type CredentialProvider } from "./types.js";

export interface DeviceFlowAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
  readonly interval: number;
  /** Absolute expiry recorded by this provider's monotonic wall-clock source. */
  readonly expiresAt: number;
}

export interface DeviceFlowFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type DeviceFlowFetch = (input: string, init?: RequestInit) => Promise<DeviceFlowFetchResponse>;

export interface DeviceFlowCredentialProviderOptions {
  readonly clientId: string;
  readonly scopes?: readonly string[];
  readonly fetch?: DeviceFlowFetch;
  readonly endpoints?: {
    readonly deviceCode?: string;
    readonly accessToken?: string;
  };
  readonly onVerification: (authorization: DeviceFlowAuthorization) => void | Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

export interface DeviceFlowDriver {
  start(): Promise<DeviceFlowAuthorization>;
  poll(authorization: DeviceFlowAuthorization): Promise<Credential>;
}

const DEFAULT_DEVICE_CODE_ENDPOINT = "https://github.com/login/device/code";
const DEFAULT_ACCESS_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const SLOW_DOWN_SECONDS = 5;

/** Browser-capable OAuth Device Authorization Grant provider; it embeds no client secret. */
export class DeviceFlowCredentialProvider implements CredentialProvider, DeviceFlowDriver {
  readonly #clientId: string;
  readonly #scopes: readonly string[];
  readonly #fetch: DeviceFlowFetch;
  readonly #deviceCodeEndpoint: string;
  readonly #accessTokenEndpoint: string;
  readonly #onVerification: DeviceFlowCredentialProviderOptions["onVerification"];
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  #credential: Credential | null = null;

  constructor(options: DeviceFlowCredentialProviderOptions) {
    this.#clientId = options.clientId.trim();
    if (!this.#clientId) throw protocol("A GitHub OAuth clientId is required for Device Flow.");
    this.#scopes = (options.scopes ?? []).map((scope) => scope.trim()).filter(Boolean);
    this.#fetch = options.fetch ?? defaultDeviceFetch;
    this.#deviceCodeEndpoint = options.endpoints?.deviceCode ?? DEFAULT_DEVICE_CODE_ENDPOINT;
    this.#accessTokenEndpoint = options.endpoints?.accessToken ?? DEFAULT_ACCESS_TOKEN_ENDPOINT;
    this.#onVerification = options.onVerification;
    this.#sleep = options.sleep ?? wait;
    this.#now = options.now ?? Date.now;
  }

  async start(): Promise<DeviceFlowAuthorization> {
    const body = new URLSearchParams({ client_id: this.#clientId });
    if (this.#scopes.length) body.set("scope", this.#scopes.join(" "));
    const value = await this.#post(this.#deviceCodeEndpoint, body);
    const expiresIn = positiveNumber(value, "expires_in");
    const interval = value.interval === undefined ? 5 : positiveNumber(value, "interval");
    return {
      deviceCode: stringValue(value, "device_code"),
      userCode: stringValue(value, "user_code"),
      verificationUri: stringValue(value, "verification_uri"),
      ...(typeof value.verification_uri_complete === "string"
        ? { verificationUriComplete: value.verification_uri_complete }
        : {}),
      expiresIn,
      interval,
      expiresAt: this.#now() + expiresIn * 1000,
    };
  }

  async poll(authorization: DeviceFlowAuthorization): Promise<Credential> {
    let intervalSeconds = authorization.interval;
    while (true) {
      if (this.#now() >= authorization.expiresAt) throw expired();
      await this.#sleep(intervalSeconds * 1000);
      if (this.#now() >= authorization.expiresAt) throw expired();

      const value = await this.#post(
        this.#accessTokenEndpoint,
        new URLSearchParams({
          client_id: this.#clientId,
          device_code: authorization.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      );
      if (typeof value.access_token === "string" && value.access_token.trim()) {
        const credential: Credential = {
          kind: "device-flow",
          token: value.access_token.trim(),
          createdAt: new Date(this.#now()).toISOString(),
        };
        this.#credential = credential;
        return credential;
      }

      const error = typeof value.error === "string" ? value.error : undefined;
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        intervalSeconds += SLOW_DOWN_SECONDS;
        continue;
      }
      if (error === "expired_token") throw expired();
      if (error === "access_denied") {
        throw new CredentialError("device-flow-denied", "GitHub Device Flow authorization was denied.");
      }
      throw protocol("GitHub returned an unexpected Device Flow polling response.");
    }
  }

  async connect(): Promise<Credential> {
    const authorization = await this.start();
    await this.#onVerification(authorization);
    return this.poll(authorization);
  }

  async get(): Promise<Credential | null> {
    return this.#credential;
  }

  async disconnect(): Promise<void> {
    this.#credential = null;
  }

  async #post(endpoint: string, body: URLSearchParams): Promise<Record<string, unknown>> {
    let response: DeviceFlowFetchResponse;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (cause) {
      throw new CredentialError("network", "Could not reach the GitHub Device Flow endpoint.", { cause });
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch (cause) {
      throw new CredentialError("device-flow-protocol", "GitHub returned an unreadable Device Flow response.", { cause });
    }
    if (!isRecord(value)) throw protocol("GitHub returned an invalid Device Flow response.");
    // OAuth errors are often returned with 200 or 400. Preserve recognized error bodies for poll().
    if (!response.ok && typeof value.error !== "string") {
      throw protocol(`GitHub Device Flow request failed with status ${response.status}.`);
    }
    return value;
  }
}

const defaultDeviceFetch: DeviceFlowFetch = async (input, init) => fetch(input, init);

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function expired(): CredentialError {
  return new CredentialError("device-flow-expired", "GitHub Device Flow authorization expired. Start again.");
}

function protocol(message: string): CredentialError {
  return new CredentialError("device-flow-protocol", message);
}

function stringValue(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) throw protocol(`Device Flow response is missing ${field}.`);
  return value;
}

function positiveNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw protocol(`Device Flow response is missing ${field}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
