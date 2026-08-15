import assert from "node:assert/strict";
import test from "node:test";
import {
  definePrivatePlugin,
  githubPrivatePluginArtifactUrl,
  parsePrivatePluginRequest,
  privatePluginCacheName,
  privatePluginEntryUrl
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
