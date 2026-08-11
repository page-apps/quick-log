import assert from "node:assert/strict";
import test from "node:test";
import { STANDARD_SECURITY_DISCLOSURE, SECURITY_DISCLOSURE, statusLabel } from "../dist/index.js";

test("the framework-owned disclosure covers shared origin and repository blast radius", () => {
  assert.equal(STANDARD_SECURITY_DISCLOSURE, SECURITY_DISCLOSURE);
  assert.match(STANDARD_SECURITY_DISCLOSURE, /same origin/);
  assert.match(STANDARD_SECURITY_DISCLOSURE, /every repository/);
  assert.match(STANDARD_SECURITY_DISCLOSURE, /fine-grained, expiring token/);
});

test("lifecycle status labels distinguish committed and published", () => {
  assert.equal(statusLabel("committed"), "Committed");
  assert.equal(statusLabel("building"), "Building…");
  assert.equal(statusLabel("published"), "Published");
});
