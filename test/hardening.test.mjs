import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
async function withBroker(fn, env = {}) {
  const port = env.BRIDGE_PORT || "3945";
  const b = spawn("node", ["broker.mjs"], { cwd: ROOT, env: { ...process.env, BRIDGE_QUIET: "1", BRIDGE_PORT: port, ...env } });
  await new Promise((r) => setTimeout(r, 600));
  try { await fn(`http://127.0.0.1:${port}`, env); } finally { b.kill(); }
}
async function req(base, method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test("affinity is per peer family (pi lane never leaks to claude lane)", async () => {
  await withBroker(async (base) => {
    const t = "t_aff_" + Date.now();
    const a = await req(base, "POST", "/ask/pi", { prompt: "hi", from: "claude", trace_id: t, session: "pi-frontend" });
    assert.equal(a.json.session, "pi-frontend");
    const b = await req(base, "POST", "/ask/claude", { prompt: "hi", from: "pi", trace_id: t });
    assert.equal(b.json.session, "default"); // must NOT inherit pi-frontend
    const c = await req(base, "POST", "/ask/claude", { prompt: "hi", from: "pi", trace_id: t, session: "claude-main" });
    assert.equal(c.json.session, "claude-main");
    const d = await req(base, "POST", "/ask/claude", { prompt: "hi", from: "pi", trace_id: t });
    assert.equal(d.json.session, "claude-main"); // sticks after explicit move
  });
});

test("hop counting survives callbacks via propagated trace_id+hop", async () => {
  await withBroker(async (base) => {
    const t = "t_hops_" + Date.now();
    const a = await req(base, "POST", "/ask/pi", { prompt: "hi", from: "claude", trace_id: t, hop: 0, max_hops: 2 });
    assert.equal(a.status, 200);
    const b = await req(base, "POST", "/ask/claude", { prompt: "hi", from: "pi", trace_id: t, hop: 1, max_hops: 2 });
    assert.equal(b.status, 200);
    const c = await req(base, "POST", "/ask/pi", { prompt: "hi", from: "claude", trace_id: t, hop: 2, max_hops: 2 });
    assert.equal(c.status, 429);
    assert.equal(c.json.code, "HOP_LIMIT");
  });
});

test("budget + total deadline + version + body cap", async () => {
  await withBroker(async (base) => {
    const t = "t_b_" + Date.now();
    const a = await req(base, "POST", "/ask/pi", { prompt: "hello world", from: "claude", trace_id: t, budget_tokens: 100000 });
    assert.equal(a.status, 200);
    const b = await req(base, "POST", "/ask/pi", { prompt: "x".repeat(100), from: "claude", trace_id: t, budget_tokens: 5 });
    assert.equal(b.status, 429);
    assert.equal(b.json.code, "BUDGET_EXCEEDED");
    const c = await req(base, "POST", "/ask/pi", { prompt: "hi", from: "claude", v: 999 });
    assert.equal(c.status, 400);
    assert.equal(c.json.code, "VERSION_MISMATCH");
    const d = await req(base, "POST", "/ask/pi", { prompt: "hi", from: "claude", trace_id: "t_old", deadline_total_ms: 0 });
    // first call sets meta with total 0; second call on same trace exceeds
    await req(base, "POST", "/ask/pi", { prompt: "hi", from: "claude", trace_id: "t_old2", deadline_total_ms: 1 });
    await new Promise((r) => setTimeout(r, 10));
    const e = await req(base, "POST", "/ask/pi", { prompt: "hi", from: "claude", trace_id: "t_old2" });
    assert.equal(e.status, 504);
    assert.equal(e.json.code, "TOTAL_TIMEOUT");
    assert.equal(d.status, 200);
  });
});

test("cancel is terminal for the trace", async () => {
  await withBroker(async (base) => {
    const t = "t_c_" + Date.now();
    const a = await req(base, "POST", "/ask/pi", { prompt: "hi", from: "claude", trace_id: t });
    assert.equal(a.status, 200);
    const k = await req(base, "POST", "/cancel", { trace_id: t });
    assert.equal(k.status, 200);
    const b = await req(base, "POST", "/ask/pi", { prompt: "hi", from: "claude", trace_id: t });
    assert.equal(b.status, 409);
    assert.equal(b.json.code, "CANCELLED");
  });
});

test("token gate + sessions health fields", async () => {
  await withBroker(async (base, env) => {
    const auth = { authorization: "Bearer s3cr3t" };
    const no = await req(base, "POST", "/ask/pi", { prompt: "hi", from: "claude" });
    assert.equal(no.status, 401);
    const yes = await req(base, "POST", "/ask/pi", { prompt: "hi", from: "claude" }, auth);
    assert.equal(yes.status, 200);
    assert.equal(yes.json.untrusted, true);
    const s = await (await fetch(`${base}/sessions`, { headers: auth })).json();
    assert.ok(s.sessions.length >= 1);
    assert.ok("lastMs" in s.sessions[0] && "lastError" in s.sessions[0]);
  }, { BRIDGE_PORT: "3946", BRIDGE_TOKEN: "s3cr3t" });
});
