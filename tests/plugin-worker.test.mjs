import { describe, expect, it, vi } from "vitest";
import {
  createPrivatePluginTransport,
  githubArtifactUrl,
  parsePluginRequest
} from "../public/plugin-worker.js";

const sha = "a".repeat(40);
const origin = "https://host.test";
const virtualPrefix = "/quick-log/__plugins/";
const virtual = (path = "mf-manifest.json") => `${origin}${virtualPrefix}todo-list/${sha}/${path}`;

function fakeCaches() {
  const stores = new Map();
  return {
    stores,
    async keys() { return [...stores.keys()]; },
    async delete(key) { return stores.delete(key); },
    async open(key) {
      const store = stores.get(key) ?? new Map();
      stores.set(key, store);
      return {
        async match(request) { return store.get(request.url)?.clone(); },
        async put(request, response) { store.set(request.url, response.clone()); }
      };
    }
  };
}

describe("Quick Log private plugin request boundary", () => {
  it("anchors virtual paths to the worker origin and project base", () => {
    const parsed = parsePluginRequest(virtual("assets/App.js"), { origin, virtualPrefix });
    expect(parsed).toMatchObject({ artifactPath: "assets/App.js", commitSha: sha });
    expect(githubArtifactUrl(parsed)).toBe(
      `https://api.github.com/repos/page-apps/todo-list-plugin/contents/dist/assets/App.js?ref=${sha}`
    );
    expect(parsePluginRequest(`${origin}/unrelated/__plugins/todo-list/${sha}/remoteEntry.js`, { origin, virtualPrefix })).toBeNull();
    expect(() => parsePluginRequest(`https://evil.test${virtualPrefix}todo-list/${sha}/remoteEntry.js`, { origin, virtualPrefix })).toThrow(/origin/i);
  });

  it.each([
    `${origin}${virtualPrefix}todo-list/main/remoteEntry.js`,
    `${origin}${virtualPrefix}unknown/${sha}/remoteEntry.js`,
    `${origin}${virtualPrefix}todo-list/${sha}/assets/../remoteEntry.js`,
    `${origin}${virtualPrefix}todo-list/${sha}/assets%2Fsecret.js`,
    `${origin}${virtualPrefix}todo-list/${sha}/remoteEntry.js?token=never`,
    `${origin}${virtualPrefix}todo-list/${sha}/artifact.exe`
  ])("rejects an unsafe request: %s", (url) => {
    expect(() => parsePluginRequest(url, { origin, virtualPrefix })).toThrow();
  });
});

describe("Quick Log private plugin credential lifecycle", () => {
  it("returns no private bytes without a worker credential", async () => {
    const fetchImpl = vi.fn();
    const transport = createPrivatePluginTransport({ fetchImpl, cachesImpl: fakeCaches(), origin, virtualPrefix });
    expect((await transport.handle(new Request(virtual())))?.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("puts the token only on the fixed GitHub API request and clears SHA caches", async () => {
    const cachesImpl = fakeCaches();
    const fetchImpl = vi.fn(async (input, init) => {
      expect(String(input)).not.toContain("private-token");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-token");
      return new Response("export default {};", { status: 200 });
    });
    const transport = createPrivatePluginTransport({ fetchImpl, cachesImpl, origin, virtualPrefix });
    transport.setCredential("private-token");
    const request = new Request(virtual("remoteEntry.js"));
    expect((await transport.handle(request))?.headers.get("content-type")).toContain("text/javascript");
    await transport.handle(request);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect([...cachesImpl.stores.keys()].join(" ")).toContain(sha);
    expect([...cachesImpl.stores.keys()].join(" ")).not.toContain("private-token");
    await transport.clearCredential();
    expect(cachesImpl.stores.size).toBe(0);
    expect((await transport.handle(request))?.status).toBe(401);
  });

  it("allows the deterministic fixture only when the loopback host enables it", () => {
    const denied = createPrivatePluginTransport({ cachesImpl: fakeCaches(), origin, virtualPrefix });
    expect(() => denied.setCredential("fixture-token", { fixture: true })).toThrow(/not available/i);
    const allowed = createPrivatePluginTransport({ cachesImpl: fakeCaches(), origin, virtualPrefix, allowFixture: true });
    expect(() => allowed.setCredential("fixture-token", { fixture: true })).not.toThrow();
  });
});
