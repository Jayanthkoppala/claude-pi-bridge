import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSession } from "../lib/envelope.mjs";

test("session defaults + validation", () => {
  assert.equal(normalizeSession(undefined), "default");
  assert.equal(normalizeSession("pi-frontend"), "pi-frontend");
  assert.throws(() => normalizeSession(""), /BAD_SESSION/);
  assert.throws(() => normalizeSession("../evil"), /BAD_SESSION/);
  assert.throws(() => normalizeSession("x".repeat(65)), /BAD_SESSION/);
});
