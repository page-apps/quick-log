const PLUGIN = Object.freeze({
  id: "todo-list",
  owner: "page-apps",
  repository: "todo-list-plugin",
  artifactPrefix: "dist"
});

const WORKER_BASE = new URL("./", globalThis.location?.href ?? "https://host.invalid/").pathname;
const VIRTUAL_PREFIX = `${WORKER_BASE}__plugins/`;
const CACHE_PREFIX = "private-plugin:todo-list:v2:";
const API_VERSION = "2022-11-28";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const MIME_TYPES = Object.freeze({
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

export function mimeTypeFor(pathname) {
  const dot = pathname.lastIndexOf(".");
  if (dot < 0) return null;
  return MIME_TYPES[pathname.slice(dot).toLowerCase()] ?? null;
}

function rawPathname(input) {
  return String(input).replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, "").split(/[?#]/, 1)[0] || "/";
}

export function parsePluginRequest(input, options = {}) {
  const rawInput = String(input);
  const rawPath = rawPathname(rawInput);
  if (/\\/.test(rawInput) || rawPath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Traversal and backslash plugin paths are not allowed.");
  }
  const url = new URL(rawInput, "https://host.invalid/");
  const expectedOrigin = options.origin ?? url.origin;
  const virtualPrefix = options.virtualPrefix ?? VIRTUAL_PREFIX;
  if (url.origin !== expectedOrigin) throw new Error("Plugin artifacts must use the worker origin.");
  if (url.search || url.hash) throw new Error("Plugin artifact URLs must not contain query strings or fragments.");
  if (!url.pathname.startsWith(virtualPrefix)) return null;

  const rawTail = rawPath.slice(virtualPrefix.length);
  if (!rawTail || /%|\\/.test(rawTail)) throw new Error("Encoded or backslash plugin paths are not allowed.");
  const segments = rawTail.split("/");
  if (segments.length < 3 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("The plugin artifact path is invalid.");
  }
  const [pluginId, commitSha, ...artifactSegments] = segments;
  if (pluginId !== PLUGIN.id) throw new Error("The plugin id is not registered.");
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error("The plugin version must be an immutable commit SHA.");
  if (artifactSegments.some((segment) => !/^[A-Za-z0-9._@+-]+$/.test(segment))) {
    throw new Error("The plugin artifact contains unsupported characters.");
  }
  const artifactPath = artifactSegments.join("/");
  const contentType = mimeTypeFor(artifactPath);
  if (!contentType) throw new Error("The plugin artifact type is not allowlisted.");
  return { pluginId, commitSha, artifactPath, contentType, virtualUrl: url.toString() };
}

export function githubArtifactUrl(parsed) {
  const encodedPath = [PLUGIN.artifactPrefix, ...parsed.artifactPath.split("/")].map(encodeURIComponent).join("/");
  const api = new URL(`https://api.github.com/repos/${PLUGIN.owner}/${PLUGIN.repository}/contents/${encodedPath}`);
  api.searchParams.set("ref", parsed.commitSha);
  return api.toString();
}

function fixtureArtifactUrl(parsed, origin) {
  return new URL(`${WORKER_BASE}__todo-plugin-fixture__/${parsed.artifactPath}`, origin).toString();
}

function unavailable(message, status = 401) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export function createPrivatePluginTransport({ fetchImpl = fetch, cachesImpl = caches, origin = "https://host.invalid", virtualPrefix = VIRTUAL_PREFIX, allowFixture = false } = {}) {
  let credential = null;
  let fixture = false;
  return {
    setCredential(token, options = {}) {
      if (typeof token !== "string" || token.length < 8) throw new Error("A credential is required.");
      if (options.fixture && !allowFixture) throw new Error("The local plugin fixture is not available on this origin.");
      credential = token;
      fixture = Boolean(options.fixture);
    },
    async clearCredential() {
      credential = null;
      fixture = false;
      const keys = await cachesImpl.keys();
      await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => cachesImpl.delete(key)));
    },
    hasCredential() { return credential !== null; },
    async handle(request) {
      let parsed;
      try {
        parsed = parsePluginRequest(request.url, { origin, virtualPrefix });
      } catch (error) {
        return unavailable(error instanceof Error ? error.message : "Invalid plugin request.", 400);
      }
      if (!parsed) return null;
      if (request.method !== "GET") return unavailable("Only GET is supported for plugin artifacts.", 405);
      if (!credential) return unavailable("Connect the private plugin before loading artifacts.");
      const cache = await cachesImpl.open(`${CACHE_PREFIX}${parsed.commitSha}`);
      const cached = await cache.match(request);
      if (cached) return cached;

      let sourceResponse;
      try {
        const sourceUrl = fixture ? fixtureArtifactUrl(parsed, origin) : githubArtifactUrl(parsed);
        sourceResponse = await fetchImpl(sourceUrl, fixture ? {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin"
        } : {
          method: "GET",
          headers: {
            Accept: "application/vnd.github.raw+json",
            Authorization: `Bearer ${credential}`,
            "X-GitHub-Api-Version": API_VERSION
          },
          cache: "no-store",
          credentials: "omit",
          redirect: "error"
        });
      } catch {
        return unavailable("The private plugin repository is unavailable.", 503);
      }
      if (!sourceResponse.ok) {
        const status = [401, 403, 404, 429].includes(sourceResponse.status) ? sourceResponse.status : 502;
        return unavailable("The private plugin source did not return the requested artifact.", status);
      }
      const headers = new Headers({
        "Content-Type": parsed.contentType,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin"
      });
      const etag = sourceResponse.headers.get("etag");
      if (etag) headers.set("ETag", etag);
      const response = new Response(await sourceResponse.arrayBuffer(), { status: 200, headers });
      await cache.put(request, response.clone());
      return response;
    }
  };
}

const isServiceWorker = typeof ServiceWorkerGlobalScope !== "undefined" && globalThis instanceof ServiceWorkerGlobalScope;
if (isServiceWorker) {
  const origin = globalThis.location.origin;
  const transport = createPrivatePluginTransport({
    origin,
    virtualPrefix: VIRTUAL_PREFIX,
    allowFixture: LOOPBACK_HOSTS.has(globalThis.location.hostname)
  });
  globalThis.addEventListener("install", (event) => event.waitUntil(globalThis.skipWaiting()));
  globalThis.addEventListener("activate", (event) => event.waitUntil(globalThis.clients.claim()));
  globalThis.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "todo-plugin-credential-ready") {
      try {
        transport.setCredential(message.token, { fixture: message.fixture === true });
        event.ports[0]?.postMessage({ ok: true });
      } catch (error) {
        event.ports[0]?.postMessage({ ok: false, error: error instanceof Error ? error.message : "Credential rejected" });
      }
    }
    if (message.type === "todo-plugin-credential-cleared") {
      event.waitUntil(transport.clearCredential().then(() => event.ports[0]?.postMessage({ ok: true })));
    }
  });
  globalThis.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== origin || !url.pathname.startsWith(VIRTUAL_PREFIX)) return;
    event.respondWith(transport.handle(event.request).then((response) => response ?? fetch(event.request)));
  });
}
