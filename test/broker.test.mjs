import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;

async function withBroker(fn) {
  const b = spawn("node", ["broker.mjs"], { cwd: ROOT, env: { ...process.env, BRIDGE_QUIET: "1", BRIDGE_PORT: "3941" } });
  await new Promise((r) => setTimeout(r, 600));
  try { await fn("http://127.0.0.1:3941"); } finally { b.kill(); }
}
async function ask(base, peer, body) {
  const res = await fetch(`${base}/ask/${peer}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

test("broker mock ask + trace + hop-limit", async () => {
  await withBroker(async (base) => {
    const a = await ask(base, "pi", { prompt: "hello", from: "claude" });
    assert.equal(a.status, 200);
    assert.match(a.json.text, /mock:pi/);
    const t = await (await fetch(`${base}/traces/${a.json.trace_id}`)).json();
    assert.equal(t.hops.length, 1);
    const c = await ask(base, "pi", { prompt: "x", from: "claude", hop: 3, max_hops: 3 });
    assert.equal(c.status, 429);
    assert.equal(c.json.code, "HOP_LIMIT");
  });
});

test("mcp server tools/list + tools/call (mock)", async () => {
  await withBroker(async () => {
    const mcp = spawn("node", ["broker-mcp.mjs"], { cwd: ROOT, env: { ...process.env, BRIDGE_URL: "http://127.0.0.1:3941" } });
    let buf = "";
    const out = [];
    mcp.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) out.push(JSON.parse(l)); } });
    await new Promise((r) => setTimeout(r, 300));
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_pi", arguments: { prompt: "what time is it?" } } }) + "\n");
    await new Promise((r) => setTimeout(r, 1200));
    mcp.kill();
    const list = out.find((o) => o.id === 1);
    const call = out.find((o) => o.id === 2);
    assert.ok(list.result.tools.find((t) => t.name === "ask_pi"));
    assert.match(call.result.content[0].text, /mock:pi/);
  });
});
