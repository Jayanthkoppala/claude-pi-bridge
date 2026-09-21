#!/usr/bin/env node
// Mock nested demo: Claude -> Pi -> Claude, hop-traced, no LLM spend.
import { spawn } from "node:child_process";

const broker = spawn("node", ["broker.mjs"], { cwd: new URL(".", import.meta.url).pathname, env: { ...process.env, BRIDGE_QUIET: "1" } });
await new Promise((r) => setTimeout(r, 600));

async function ask(peer, body) {
  const res = await fetch(`http://127.0.0.1:3939/ask/${peer}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

console.log("1. Claude asks Pi what time it is:");
const a = await ask("pi", { prompt: "what time is it?", from: "claude" });
console.log("  ", a.json.text, `(trace ${a.json.trace_id}, hops ${a.json.hops_used})`);

console.log("2. Pi calls back to Claude with [CALLBACK] (nesting):");
const b = await ask("pi", { prompt: "[CALLBACK] format this time for a human", from: "claude", trace_id: a.json.trace_id, hop: 1 });
console.log("  ", b.json.text);

console.log("3. Hop limit (max_hops=1, hop=1 -> reject):");
const c = await ask("pi", { prompt: "should fail", from: "claude", hop: 1, max_hops: 1 });
console.log("  ", c.status, c.json.code);

const t = await (await fetch(`http://127.0.0.1:3939/traces/${a.json.trace_id}`)).json();
console.log("4. Trace DAG:", JSON.stringify(t.hops));
broker.kill();
console.log("demo ok (mock, no LLM spend). For real peers: BRIDGE_REAL=1 node broker.mjs");
