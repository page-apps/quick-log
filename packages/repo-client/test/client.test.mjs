import assert from "node:assert/strict";
import test from "node:test";
import {
  ConflictError,
  RateLimitError,
  createRepositoryClient,
} from "../dist/index.js";

function response(status, body, headers = {}) {
  const normalised = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalised[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function client(fetch) {
  return createRepositoryClient({
    repository: { owner: "owner", name: "quick-log", branch: "main" },
    credentials: { get: async () => ({ token: "github_pat_secret_12345678" }) },
    fetch,
  });
}

test("all file operations are self-bound and decode unicode content", async () => {
  let request;
  const api = client(async (url, init) => {
    request = { url, init };
    return response(200, {
      type: "file", path: "data/log.json", sha: "blob-1", size: 2,
      content: Buffer.from("✓", "utf8").toString("base64"),
    });
  });
  const file = await api.readFile("data/log.json");
  assert.equal(file.content, "✓");
  assert.match(request.url, /^https:\/\/api\.github\.com\/repos\/owner\/quick-log\/contents\/data\/log\.json\?ref=main$/);
  assert.equal(request.init.headers.Authorization, "Bearer github_pat_secret_12345678");
});

test("update includes the expected SHA", async () => {
  let body;
  const api = client(async (_url, init) => {
    body = JSON.parse(init.body);
    return response(200, {
      content: { path: "data/log.json", sha: "blob-2" },
      commit: { sha: "commit-2", html_url: "https://github.test/commit-2" },
    });
  });
  const result = await api.updateFile({ path: "data/log.json", content: "[]", message: "Update log", expectedSha: "blob-1" });
  assert.equal(body.sha, "blob-1");
  assert.equal(result.commitSha, "commit-2");
});

test("stale update is normalized to ConflictError", async () => {
  const api = client(async () => response(409, { message: "conflict" }));
  await assert.rejects(
    api.updateFile({ path: "data/log.json", content: "[]", message: "Update", expectedSha: "stale" }),
    (error) => error instanceof ConflictError && error.expectedSha === "stale",
  );
});

test("rate limiting includes reset time without exposing response bodies", async () => {
  const api = client(async () => response(403, { message: "secret" }, {
    "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1786233600",
  }));
  await assert.rejects(api.verifyAccess(), (error) => error instanceof RateLimitError && error.retryAt instanceof Date);
});

test("workflow and Pages status are normalized", async () => {
  const api = client(async (url) => {
    if (url.includes("actions/runs")) return response(200, { workflow_runs: [{ id: 4, head_sha: "abc", status: "in_progress", html_url: "run" }] });
    if (url.includes("/deployments/7/statuses")) return response(200, [{ state: "success", environment_url: "site" }]);
    return response(200, [{ id: 7, url: "deployment" }]);
  });
  assert.equal((await api.getWorkflowStatus("abc")).phase, "building");
  assert.equal((await api.getPagesDeploymentStatus("abc")).phase, "published");
});

test("delete sends the expected blob SHA and returns the commit", async () => {
  let request;
  const api = client(async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return response(200, { content: null, commit: { sha: "delete-commit", html_url: "commit-url" } });
  });
  const result = await api.deleteFile({ path: "data/old.json", expectedSha: "blob-old", message: "Delete old record" });
  assert.equal(request.init.method, "DELETE");
  assert.equal(request.body.sha, "blob-old");
  assert.equal(request.body.branch, "main");
  assert.equal(result.commitSha, "delete-commit");
  assert.equal(result.deletedSha, "blob-old");
});

test("stale delete is normalized to ConflictError", async () => {
  const api = client(async () => response(422, { message: "sha does not match" }));
  await assert.rejects(
    api.deleteFile({ path: "data/old.json", expectedSha: "stale", message: "Delete" }),
    (error) => error instanceof ConflictError && error.expectedSha === "stale",
  );
});

test("batch commit creates blobs, a base tree, one commit, and advances the self branch atomically", async () => {
  const requests = [];
  const api = client(async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init.method ?? "GET", body });
    if (url.endsWith("/git/ref/heads/main")) return response(200, { object: { sha: "head-1" } });
    if (url.endsWith("/git/commits/head-1")) return response(200, { tree: { sha: "tree-1" } });
    if (url.includes("/contents/data%2Fold.json")) throw new Error("path encoding should preserve segments");
    if (url.includes("/contents/data/old.json")) return response(200, {
      type: "file", path: "data/old.json", sha: "old-blob", size: 2, content: "e30=",
    });
    if (url.endsWith("/git/blobs")) return response(201, { sha: "new-blob" });
    if (url.endsWith("/git/trees")) return response(201, { sha: "tree-2" });
    if (url.endsWith("/git/commits") && init.method === "POST") {
      return response(201, { sha: "commit-2", html_url: "commit-url" });
    }
    if (url.endsWith("/git/refs/heads/main")) return response(200, { object: { sha: "commit-2" } });
    throw new Error(`Unexpected URL: ${url}`);
  });
  const result = await api.batchCommit({
    message: "Atomic update",
    expectedHeadSha: "head-1",
    changes: [
      { operation: "write", path: "data/new.json", content: "{\"new\":true}" },
      { operation: "delete", path: "data/old.json", expectedSha: "old-blob" },
    ],
  });
  const treeRequest = requests.find((request) => request.url.endsWith("/git/trees"));
  const refRequest = requests.find((request) => request.method === "PATCH");
  assert.deepEqual(treeRequest.body.tree, [
    { path: "data/new.json", mode: "100644", type: "blob", sha: "new-blob" },
    { path: "data/old.json", mode: "100644", type: "blob", sha: null },
  ]);
  assert.deepEqual(refRequest.body, { sha: "commit-2", force: false });
  assert.equal(result.previousHeadSha, "head-1");
  assert.equal(result.commitSha, "commit-2");
});

test("batch commit rejects an unexpected branch head before creating objects", async () => {
  let calls = 0;
  const api = client(async () => {
    calls += 1;
    return response(200, { object: { sha: "new-head" } });
  });
  await assert.rejects(
    api.batchCommit({ message: "Atomic", expectedHeadSha: "old-head", changes: [{ operation: "write", path: "data/a", content: "a" }] }),
    (error) => error instanceof ConflictError && error.expectedSha === "old-head",
  );
  assert.equal(calls, 1);
});

test("concurrent branch advance during batch ref update becomes a conflict", async () => {
  const api = client(async (url, init = {}) => {
    if (url.endsWith("/git/ref/heads/main")) return response(200, { object: { sha: "head" } });
    if (url.endsWith("/git/commits/head")) return response(200, { tree: { sha: "tree" } });
    if (url.endsWith("/git/blobs")) return response(201, { sha: "blob" });
    if (url.endsWith("/git/trees")) return response(201, { sha: "tree-2" });
    if (url.endsWith("/git/commits") && init.method === "POST") return response(201, { sha: "commit" });
    if (url.endsWith("/git/refs/heads/main")) return response(422, { message: "not fast forward" });
    throw new Error(`Unexpected URL ${url}`);
  });
  await assert.rejects(
    api.batchCommit({ message: "Atomic", changes: [{ operation: "write", path: "data/a", content: "a" }] }),
    (error) => error instanceof ConflictError && error.expectedSha === "head",
  );
});
