import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TODO_PLUGIN_REPOSITORY,
  TODO_STATE_PATH,
  TODO_STATE_REPOSITORY,
  createTodoRepositoryCapabilities,
  verifyTodoPluginArtifactAccess
} from "../src/lib/plugins/todo-data";

const collection = {
  schemaVersion: 1 as const,
  tasks: [{
    id: "task-20260816090000-a1b2c3",
    title: "Persist Todo state",
    description: "Write through a host-owned capability.",
    status: "todo" as const,
    priority: "high" as const,
    tags: ["state"],
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z"
  }]
};

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" }
});

const credential = {
  async connect() { return { kind: "pat" as const, token: "github_pat_private_state", createdAt: "2026-08-16T00:00:00.000Z" }; },
  async get() { return { kind: "pat" as const, token: "github_pat_private_state", createdAt: "2026-08-16T00:00:00.000Z" }; },
  async disconnect() {}
};

afterEach(() => vi.unstubAllGlobals());

describe("Todo private repository host capability", () => {
  it("fixes repository identities, validates state and advances the blob revision", async () => {
    let content = `${JSON.stringify(collection)}\n`;
    let sha = "blob-1";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith(`/repos/${TODO_PLUGIN_REPOSITORY.owner}/${TODO_PLUGIN_REPOSITORY.name}`)) {
        return json({ full_name: "page-apps/todo-list-plugin", default_branch: "main", permissions: { pull: true, push: false } });
      }
      if (url.endsWith(`/repos/${TODO_STATE_REPOSITORY.owner}/${TODO_STATE_REPOSITORY.name}`)) {
        return json({ full_name: "page-apps/todo-list-data", default_branch: "main", permissions: { pull: true, push: true } });
      }
      if (url.includes(`/contents/${TODO_STATE_PATH}`) && (init?.method ?? "GET") === "GET") {
        return json({ type: "file", path: TODO_STATE_PATH, sha, content: btoa(content), size: content.length });
      }
      if (url.includes(`/contents/${TODO_STATE_PATH}`) && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        expect(body.sha).toBe("blob-1");
        content = atob(body.content);
        sha = "blob-2";
        return json({ content: { path: TODO_STATE_PATH, sha }, commit: { sha: "commit-1", html_url: "https://github.test/commit-1" } });
      }
      return json({ message: "not found" }, 404);
    }));

    await verifyTodoPluginArtifactAccess(credential, "https://api.test");
    const capability = await createTodoRepositoryCapabilities(credential, "https://api.test");
    const loaded = await capability.loadTasks();
    expect(loaded).toEqual({ collection, revision: "blob-1" });
    const saved = await capability.saveTasks(collection, loaded.revision);
    expect(saved).toEqual({ revision: "blob-2", commitSha: "commit-1", commitUrl: "https://github.test/commit-1" });
    expect(content).toBe(`${JSON.stringify(collection, null, 2)}\n`);
    expect(requests.every(({ url }) => !url.includes("github_pat_private_state"))).toBe(true);
    expect(JSON.stringify(requests.map(({ init }) => init?.headers))).toContain("github_pat_private_state");
  });

  it("rejects malformed repository state before exposing it to the remote", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("/contents/")) {
        return json({ full_name: "page-apps/todo-list-data", default_branch: "main", permissions: { pull: true, push: true } });
      }
      return json({ type: "file", path: TODO_STATE_PATH, sha: "blob-1", content: btoa('{"schemaVersion":1,"tasks":"nope"}'), size: 35 });
    }));
    const capability = await createTodoRepositoryCapabilities(credential, "https://api.test");
    await expect(capability.loadTasks()).rejects.toThrow();
  });
});
