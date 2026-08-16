export interface PrivatePluginDescriptor {
  readonly id: string;
  readonly owner: string;
  readonly repository: string;
  readonly artifactPrefix: string;
  readonly commitSha: string;
  readonly entryPath: string;
}

export interface ParsedPrivatePluginRequest {
  readonly plugin: PrivatePluginDescriptor;
  readonly artifactPath: string;
  readonly contentType: string;
}

export interface PrivatePluginRequestBoundary {
  readonly origin?: string;
  readonly virtualPrefix?: string;
}

export interface ServiceWorkerControllerOptions {
  readonly scriptUrl: string | URL;
  readonly scope: string;
  readonly timeoutMs?: number;
  readonly serviceWorkerContainer?: ServiceWorkerContainer;
}

const VIRTUAL_MARKER = "/__plugins/";
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const SAFE_ID = /^[a-z][a-z0-9-]*$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm"
});

function assertSafePath(path: string, label: string): void {
  const segments = path.split("/");
  if (!path || path.startsWith("/") || path.endsWith("/") || segments.some((segment) => !SAFE_NAME.test(segment) || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a safe relative path.`);
  }
}

export function definePrivatePlugin(descriptor: PrivatePluginDescriptor): PrivatePluginDescriptor {
  if (!SAFE_ID.test(descriptor.id)) throw new Error("Private plugin id must use lowercase letters, digits, and hyphens.");
  if (!SAFE_NAME.test(descriptor.owner) || !SAFE_NAME.test(descriptor.repository)) {
    throw new Error("Private plugin repository identity must be fixed safe names.");
  }
  if (!COMMIT_SHA.test(descriptor.commitSha)) throw new Error("Private plugin version must be an immutable 40-character commit SHA.");
  assertSafePath(descriptor.artifactPrefix, "Private plugin artifact prefix");
  assertSafePath(descriptor.entryPath, "Private plugin entry path");
  return Object.freeze({ ...descriptor });
}

export function privatePluginEntryUrl(plugin: PrivatePluginDescriptor, baseUrl: string | URL): string {
  const safe = definePrivatePlugin(plugin);
  const base = new URL(baseUrl, "https://repo-apps.invalid/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const entry = new URL(`__plugins/${safe.id}/${safe.commitSha}/${safe.entryPath}`, base);
  if (typeof baseUrl === "string" && baseUrl.startsWith("/")) return `${entry.pathname}${entry.search}${entry.hash}`;
  return entry.toString();
}

export function mimeTypeForPluginArtifact(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return MIME_TYPES[path.slice(dot).toLowerCase()] ?? null;
}

export function parsePrivatePluginRequest(
  input: string | URL,
  registry: readonly PrivatePluginDescriptor[],
  boundary: PrivatePluginRequestBoundary = {}
): ParsedPrivatePluginRequest | null {
  const rawInput = String(input);
  const rawPath = rawInput.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, "").split(/[?#]/, 1)[0] || "/";
  if (/\\/.test(rawInput) || rawPath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Traversal and backslash plugin paths are not allowed.");
  }
  const url = new URL(rawInput, "https://repo-apps.invalid/");
  const expectedOrigin = boundary.origin ?? url.origin;
  const virtualPrefix = boundary.virtualPrefix ?? VIRTUAL_MARKER;
  if (url.origin !== expectedOrigin) throw new Error("Private plugin artifacts must use the worker origin.");
  if (url.search || url.hash) throw new Error("Plugin artifact URLs must not contain query strings or fragments.");
  if (!url.pathname.startsWith(virtualPrefix)) return null;
  const rawTail = rawPath.slice(virtualPrefix.length);
  if (!rawTail || /%|\\/.test(rawTail)) throw new Error("Encoded or backslash plugin paths are not allowed.");
  const segments = rawTail.split("/");
  if (segments.length < 3 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("The private plugin artifact path is invalid.");
  }
  const [pluginId, commitSha, ...artifactSegments] = segments;
  const plugin = registry.map(definePrivatePlugin).find((entry) => entry.id === pluginId);
  if (!plugin) throw new Error("The private plugin id is not registered.");
  if (commitSha !== plugin.commitSha) throw new Error("The private plugin version is not registered.");
  if (artifactSegments.some((segment) => !SAFE_NAME.test(segment))) throw new Error("The private plugin artifact path is not allowlisted.");
  const artifactPath = artifactSegments.join("/");
  const contentType = mimeTypeForPluginArtifact(artifactPath);
  if (!contentType) throw new Error("The private plugin artifact type is not allowlisted.");
  return { plugin, artifactPath, contentType };
}

export function githubPrivatePluginArtifactUrl(parsed: ParsedPrivatePluginRequest): string {
  const path = [parsed.plugin.artifactPrefix, ...parsed.artifactPath.split("/")].map(encodeURIComponent).join("/");
  const url = new URL(`https://api.github.com/repos/${parsed.plugin.owner}/${parsed.plugin.repository}/contents/${path}`);
  url.searchParams.set("ref", parsed.plugin.commitSha);
  return url.toString();
}

export function privatePluginCacheName(plugin: PrivatePluginDescriptor): string {
  const safe = definePrivatePlugin(plugin);
  return `repo-apps:private-plugin:v1:${safe.id}:${safe.commitSha}`;
}

export async function ensureServiceWorkerControl(options: ServiceWorkerControllerOptions): Promise<ServiceWorker> {
  const container = options.serviceWorkerContainer ?? globalThis.navigator?.serviceWorker;
  if (!container) throw new Error("This browser cannot run the private plugin Service Worker.");
  await container.register(options.scriptUrl, { scope: options.scope, type: "module" });
  await container.ready;
  if (container.controller) return container.controller;
  return new Promise<ServiceWorker>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      container.removeEventListener("controllerchange", onControllerChange);
      reject(new Error("The private plugin Service Worker is active but does not control this page. Reload once and try again."));
    }, options.timeoutMs ?? 5_000);
    const onControllerChange = (): void => {
      if (!container.controller) return;
      globalThis.clearTimeout(timeout);
      container.removeEventListener("controllerchange", onControllerChange);
      resolve(container.controller);
    };
    container.addEventListener("controllerchange", onControllerChange);
  });
}

export function postPrivatePluginWorkerMessage(worker: ServiceWorker, message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent<{ ok?: boolean; error?: string }>) => {
      channel.port1.close();
      if (event.data?.ok) resolve();
      else reject(new Error(event.data?.error ?? "The private plugin Service Worker rejected the message."));
    };
    worker.postMessage(message, [channel.port2]);
  });
}

export interface PrivatePluginCredentialSource {
  get(): Promise<{ readonly token: string } | null>;
}

/** Keeps raw credential extraction inside the framework host adapter. */
export async function postPrivatePluginWorkerCredential(
  worker: ServiceWorker,
  credentials: PrivatePluginCredentialSource,
  message: Readonly<Record<string, unknown>>
): Promise<void> {
  if (Object.hasOwn(message, "token") || Object.hasOwn(message, "authorization")) {
    throw new Error("Credential worker message metadata must not contain credential fields.");
  }
  const credential = await credentials.get();
  if (!credential?.token) throw new Error("No shared credential is enabled for this plugin session.");
  await postPrivatePluginWorkerMessage(worker, { ...message, token: credential.token });
}

export * from "./state.js";
