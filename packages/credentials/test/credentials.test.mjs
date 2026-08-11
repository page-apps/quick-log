import assert from "node:assert/strict";
import test from "node:test";
import {
  CredentialError,
  DeviceFlowCredentialProvider,
  PersistentPatCredentialProvider,
  SHARED_CREDENTIAL_KEY,
  SessionPatCredentialProvider,
  SharedPatCredentialProvider,
  appCredentialStorageKey,
  redactSecrets,
} from "../dist/index.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
}

test("session PAT is stored in a versioned app-specific envelope", async () => {
  const storage = memoryStorage();
  const provider = new SessionPatCredentialProvider({
    appId: "quick-log",
    requestToken: () => "github_pat_example_12345678",
    storage,
    now: () => new Date("2026-08-09T00:00:00.000Z"),
  });
  await provider.connect();
  const stored = JSON.parse(storage.values.get(appCredentialStorageKey("quick-log")));
  assert.equal(stored.version, 1);
  assert.equal(stored.scope, "app");
  assert.equal((await provider.get()).token, "github_pat_example_12345678");
  await provider.disconnect();
  assert.equal(await provider.get(), null);
});

test("persistent providers cannot read another app's credential", async () => {
  const storage = memoryStorage();
  const first = new PersistentPatCredentialProvider({ appId: "one", requestToken: () => "token-one", storage });
  const second = new PersistentPatCredentialProvider({ appId: "two", requestToken: () => "token-two", storage });
  await first.connect();
  assert.equal(await second.get(), null);
});

test("corrupt storage is removed and rejected", async () => {
  const storage = memoryStorage();
  storage.setItem(appCredentialStorageKey("quick-log"), "not-json");
  const provider = new PersistentPatCredentialProvider({ appId: "quick-log", requestToken: () => "unused", storage });
  await assert.rejects(provider.get(), (error) => error instanceof CredentialError && error.code === "corrupt-storage");
  assert.equal(storage.getItem(appCredentialStorageKey("quick-log")), null);
});

test("redaction removes GitHub and bearer tokens", () => {
  const result = redactSecrets("github_pat_example_12345678 and Bearer abc.def-ghi");
  assert.equal(result, "[REDACTED] and [REDACTED]");
});

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("Device Flow reports verification, honors pending and slow_down, then stores the token", async () => {
  const responses = [
    { device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 2 },
    { error: "authorization_pending" },
    { error: "slow_down" },
    { access_token: "gho_device_token_12345678", token_type: "bearer" },
  ];
  const sleeps = [];
  let now = 0;
  let verification;
  const provider = new DeviceFlowCredentialProvider({
    clientId: "client-id",
    fetch: async (_url, init) => {
      assert.equal(init.method, "POST");
      assert.doesNotMatch(init.body, /secret/);
      return jsonResponse(responses.shift());
    },
    onVerification: (value) => { verification = value; },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    now: () => now,
  });
  const credential = await provider.connect();
  assert.equal(verification.userCode, "ABCD-EFGH");
  assert.deepEqual(sleeps, [2000, 2000, 7000]);
  assert.equal(credential.kind, "device-flow");
  assert.equal((await provider.get()).token, "gho_device_token_12345678");
  await provider.disconnect();
  assert.equal(await provider.get(), null);
});

test("Device Flow distinguishes denial and local expiry", async () => {
  let now = 0;
  const denied = new DeviceFlowCredentialProvider({
    clientId: "client",
    fetch: async () => jsonResponse({ error: "access_denied" }, 400),
    onVerification: () => {}, sleep: async () => {}, now: () => now,
  });
  await assert.rejects(
    denied.poll({ deviceCode: "d", userCode: "u", verificationUri: "v", expiresIn: 10, interval: 1, expiresAt: 10_000 }),
    (error) => error instanceof CredentialError && error.code === "device-flow-denied",
  );
  now = 10_000;
  await assert.rejects(
    denied.poll({ deviceCode: "d", userCode: "u", verificationUri: "v", expiresIn: 10, interval: 1, expiresAt: 10_000 }),
    (error) => error instanceof CredentialError && error.code === "device-flow-expired",
  );
});

test("shared PAT reuse is explicit and disconnect scopes are distinct", async () => {
  const storage = memoryStorage();
  const first = new SharedPatCredentialProvider({
    appId: "quick-log", repositoryHint: "owner/quick-log", requestToken: () => "github_pat_shared_12345678", storage,
    now: () => new Date("2026-08-09T00:00:00Z"),
  });
  const second = new SharedPatCredentialProvider({
    appId: "reading", repositoryHint: "owner/reading", requestToken: () => "unused", storage,
  });
  await first.connect();
  assert.equal(JSON.parse(storage.getItem(SHARED_CREDENTIAL_KEY)).version, 1);
  assert.equal(await second.hasShared(), true);
  assert.equal(await second.get(), null, "shared storage is not implicitly exposed");
  assert.equal((await second.useShared()).token, "github_pat_shared_12345678");
  assert.deepEqual(await second.listRepositoryHints(), ["owner/quick-log", "owner/reading"]);
  await second.disconnect();
  assert.equal(await second.get(), null);
  assert.notEqual(storage.getItem(SHARED_CREDENTIAL_KEY), null, "session disconnect keeps the origin vault");
  await first.disconnect({ shared: true });
  assert.equal(storage.getItem(SHARED_CREDENTIAL_KEY), null);
});
