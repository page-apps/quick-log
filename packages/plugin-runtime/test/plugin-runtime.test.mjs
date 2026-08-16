import assert from "node:assert/strict";
import test from "node:test";
import {
  createPrivatePluginStateCapability,
  definePrivatePlugin,
  githubPrivatePluginArtifactUrl,
  parsePrivatePluginRequest,
  privatePluginCacheName,
  privatePluginEntryUrl,
  postPrivatePluginWorkerCredential
} from "../dist/index.js";

const plugin = definePrivatePlugin({
  id: "todo-list",
  owner: "page-apps",
  repository: "todo-list-plugin",
  artifactPrefix: "dist",
  commitSha: "a".repeat(40),
  entryPath: "mf-manifest.json"
});
const boundary = { origin: "https://host.test", virtualPrefix: "/quick-log/__plugins/" };

test("builds a project-base-aware virtual entry", () => {
  assert.equal(privatePluginEntryUrl(plugin, "/quick-log/"), `/quick-log/__plugins/todo-list/${"a".repeat(40)}/mf-manifest.json`);
});

test("maps only the fixed private repository and immutable revision", () => {
  const parsed = parsePrivatePluginRequest(`https://host.test/quick-log/__plugins/todo-list/${"a".repeat(40)}/assets/App.js`, [plugin], boundary);
  assert.ok(parsed);
  assert.equal(githubPrivatePluginArtifactUrl(parsed), `https://api.github.com/repos/page-apps/todo-list-plugin/contents/dist/assets/App.js?ref=${"a".repeat(40)}`);
  assert.match(privatePluginCacheName(plugin), new RegExp(`${"a".repeat(40)}$`));
});

test("rejects mutable, unknown, encoded, traversing and unsupported requests", () => {
  const prefix = "https://host.test/quick-log/__plugins/todo-list/";
  for (const value of [
    `${prefix}main/remoteEntry.js`,
    `${prefix}${"b".repeat(40)}/remoteEntry.js`,
    `https://host.test/quick-log/__plugins/unknown/${"a".repeat(40)}/remoteEntry.js`,
    `${prefix}${"a".repeat(40)}/assets/../remoteEntry.js`,
    `${prefix}${"a".repeat(40)}/assets%2Fsecret.js`,
    `${prefix}${"a".repeat(40)}/secret.exe`,
    `${prefix}${"a".repeat(40)}/remoteEntry.js?token=nope`
  ]) assert.throws(() => parsePrivatePluginRequest(value, [plugin], boundary));
  assert.equal(parsePrivatePluginRequest(`https://host.test/unrelated/__plugins/todo-list/${"a".repeat(40)}/remoteEntry.js`, [plugin], boundary), null);
  assert.throws(() => parsePrivatePluginRequest(`https://evil.test/quick-log/__plugins/todo-list/${"a".repeat(40)}/remoteEntry.js`, [plugin], boundary), /origin/i);
});

test("persists validated plugin state with the last-read blob revision", async () => {
  let file = { content: '{"schemaVersion":1,"tasks":[]}', sha: "blob-1" };
  const writes = [];
  const client = {
    async readFile(path) {
      assert.equal(path, "data/tasks.json");
      return file;
    },
    async updateFile(input) {
      writes.push(input);
      if (input.expectedSha !== file.sha) {
        const error = new Error("The remote file changed.");
        error.name = "ConflictError";
        throw error;
      }
      file = { content: input.content, sha: `blob-${writes.length + 1}` };
      return { contentSha: file.sha, commitSha: `commit-${writes.length}` };
    }
  };
  const codec = {
    parse(content) {
      const value = JSON.parse(content);
      if (value.schemaVersion !== 1 || !Array.isArray(value.tasks)) throw new Error("invalid tasks");
      return value;
    },
    format(state) {
      if (state.schemaVersion !== 1 || !Array.isArray(state.tasks)) throw new Error("invalid tasks");
      return `${JSON.stringify(state)}\n`;
    }
  };
  const firstDevice = createPrivatePluginStateCapability({ client, path: "data/tasks.json", parse: codec.parse, format: codec.format, commitMessage: "Update Todo tasks" });
  const secondDevice = createPrivatePluginStateCapability({ client, path: "data/tasks.json", parse: codec.parse, format: codec.format, commitMessage: "Update Todo tasks" });
  const firstSnapshot = await firstDevice.load();
  const staleSnapshot = await secondDevice.load();
  const next = { schemaVersion: 1, tasks: [{ id: "task-one" }] };
  const committed = await firstDevice.save(next, firstSnapshot.revision);
  assert.equal(committed.revision, "blob-2");
  assert.equal(writes[0].expectedSha, "blob-1");
  await assert.rejects(() => secondDevice.save(staleSnapshot.state, staleSnapshot.revision), { name: "ConflictError" });
  assert.deepEqual((await secondDevice.load()).state, next);
});

test("rejects malformed state, unsafe paths and writes without a revision", async () => {
  const client = { async readFile() { return { content: "{}", sha: "blob-1" }; }, async updateFile() { throw new Error("should not write"); } };
  const options = { client, path: "data/tasks.json", parse() { throw new Error("invalid tasks"); }, format() { return "{}"; }, commitMessage: "Update tasks" };
  const capability = createPrivatePluginStateCapability(options);
  await assert.rejects(() => capability.load(), /invalid tasks/);
  await assert.rejects(() => capability.save({}, ""), /revision/i);
  assert.throws(() => createPrivatePluginStateCapability({ ...options, path: "../tokens.json" }), /safe fixed/i);
});

test("extracts the shared credential only inside the worker bridge", async () => {
  let delivered;
  const worker = { postMessage(message, ports) { delivered = message; ports[0].postMessage({ ok: true }); } };
  await postPrivatePluginWorkerCredential(worker, { async get() { return { token: "github_pat_shared" }; } }, { type: "plugin-credential-ready", fixture: false });
  assert.deepEqual(delivered, { type: "plugin-credential-ready", fixture: false, token: "github_pat_shared" });
  await assert.rejects(() => postPrivatePluginWorkerCredential(worker, { async get() { return null; } }, { type: "ready" }), /No shared credential/i);
  await assert.rejects(() => postPrivatePluginWorkerCredential(worker, { async get() { return { token: "secret" }; } }, { token: "not-allowed" }), /must not contain/i);
});
