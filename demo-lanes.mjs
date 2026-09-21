#!/usr/bin/env node
// Multi-lane demo: two Pi sessions isolated, trace affinity, pool list. Mock, no spend.
import { spawn } from "node:child_process";

const broker = spawn("node", ["broker.mjs"], { cwd: new URL(".", import.meta.url).pathname, env: { ...process.env, BRIDGE_QUIET: "1" } });
await new Promise((r) => setTimeout(r, 600));

async function ask(peer, body) {
  const res = await fetch(`http://127.0.0.1:3939/ask/${peer}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

const a = await ask("pi", { prompt: "what time is it?", from: "claude", session: "pi-frontend" });
console.log("frontend:", a.json.text, `[session ${a.json.session}]`);
const b = await ask("pi", { prompt: "what time is it?", from: "claude", session: "pi-backend" });
console.log("backend: ", b.json.text, `[session ${b.json.session}]`);
const c = await ask("pi", { prompt: "follow-up, no session passed", from: "claude", trace_id: a.json.trace_id });
console.log("affinity:", c.json.text, `(stuck to ${c.json.session})`);
const s = await (await fetch("http://127.0.0.1:3939/sessions")).json();
console.log("lanes:", s.sessions.map((x) => `${x.to}:${x.session}x${x.count}`).join(", "));
broker.kill();
console.log("lanes demo ok");
