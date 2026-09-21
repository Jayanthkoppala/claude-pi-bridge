import test from "node:test";
import assert from "node:assert/strict";
import { splitLF, makeEnvelope, nextHop } from "../lib/envelope.mjs";

test("splitLF: LF only, strips CR, keeps U+2028 inside", () => {
  const { lines, rest } = splitLF('{"a":"x y"}\r\n{"b":1}\npartial');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '{"a":"x y"}');
  assert.equal(rest, "partial");
});

test("hop limit enforced", () => {
  const e = makeEnvelope({ from: "claude", to: "pi", prompt: "hi", hop: 0, max_hops: 2 });
  assert.equal(e.hop, 0);
  const n = nextHop(e);
  assert.equal(n.hop, 1);
  assert.throws(() => nextHop(n), /HOP_LIMIT/);
  assert.throws(() => makeEnvelope({ from: "claude", to: "pi", prompt: "hi", hop: 2, max_hops: 2 }), /HOP_LIMIT/);
});

test("echo blocked, prompt cap", () => {
  assert.throws(() => makeEnvelope({ from: "pi", to: "pi", prompt: "x" }), /ECHO_BLOCKED/);
  assert.throws(() => makeEnvelope({ from: "a", to: "b", prompt: "x".repeat(65000) }), /PROMPT_TOO_LARGE/);
});
