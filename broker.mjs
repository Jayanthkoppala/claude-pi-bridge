import http from "node:http";
import { spawn } from "node:child_process";
import { makeEnvelope, newTraceId, redact } from "./lib/envelope.mjs";

const PORT = process.env.BRIDGE_PORT ? Number(process.env.BRIDGE_PORT) : 3939;
const REAL = process.env.BRIDGE_REAL === "1"; // real subprocesses; default mock (no LLM spend)
const traces = new Map(); // trace_id -> [{from,to,hop,ms}]

function log(...a) { if (process.env.BRIDGE_QUIET !== "1") console.log("[broker]", ...a); }

// Mock peer: instant, deterministic, supports nested-callback simulation via prompt markers.
async function mockPeer(env) {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  let text;
  if (env.prompt.includes("[CALLBACK]")) {
    // Simulate Pi calling back to Claude: consume one hop, return composed answer
    const inner = env.prompt.replace("[CALLBACK]", "").trim();
    text = `[mock:${env.to}] got "${inner.slice(0, 80)}" (hop ${env.hop}) + callback-result:[mock:claude formatted it]`;
  } else if (/what time/i.test(env.prompt)) {
    text = `[mock:${env.to}] 2026-09-21T17:00:00Z (hop ${env.hop})`;
  } else {
    text = `[mock:${env.to}] echo: ${env.prompt.slice(0, 120)} (hop ${env.hop})`;
  }
  return { text, ms: Date.now() - t0, tokens_est: Math.ceil(text.length / 4) };
}

// Real peer: spawn-per-ask (Design C). Persistent sessions land in v1.
function realPeer(env, signal) {
  const deadline = Math.min(env.deadline_ms || 60000, 120000);
  return new Promise((resolve, reject) => {
    let cmd, args;
    if (env.to === "pi") { cmd = "pi"; args = ["--mode", "json", "-p", env.prompt]; }
    else { cmd = "claude"; args = ["-p", env.prompt, "--output-format", "json", "--no-session-persistence"]; }
    const child = spawn(cmd, args, { signal });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000); } catch {} }, deadline);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(Object.assign(new Error("PEER_CRASH: " + e.message), { code: "PEER_CRASH" })); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal?.aborted) return reject(Object.assign(new Error("CANCELLED"), { code: "CANCELLED" }));
      if (!out.trim()) return reject(Object.assign(new Error("PEER_CRASH: empty output " + redact(err).slice(0, 200)), { code: "PEER_CRASH" }));
      try {
        const parsed = JSON.parse(out);
        const text = typeof parsed === "string" ? parsed : parsed.result || parsed.text || out.trim();
        resolve({ text: String(text).slice(0, 8000), ms: 0, tokens_est: Math.ceil(out.length / 4) });
      } catch { resolve({ text: out.trim().slice(0, 8000), ms: 0, tokens_est: Math.ceil(out.length / 4) }); }
    });
  });
}

async function handleAsk(peer, body) {
  const trace_id = body.trace_id || newTraceId();
  let env;
  try {
    env = makeEnvelope({ from: body.from || (peer === "pi" ? "claude" : "pi"), to: peer, prompt: body.prompt, trace_id, hop: body.hop ?? 0, max_hops: body.max_hops ?? 3, deadline_ms: body.deadline_ms ?? 60000 });
  } catch (e) {
    return { status: e.code === "HOP_LIMIT" ? 429 : 400, body: { error: e.message, code: e.code, trace_id, hops_used: e.hops_used ?? body.hop ?? 0 } };
  }
  if (!traces.has(trace_id)) traces.set(trace_id, []);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), env.deadline_ms);
  const t0 = Date.now();
  try {
    const r = REAL ? await realPeer(env, ctrl.signal) : await mockPeer(env);
    const ms = Date.now() - t0;
    traces.get(trace_id).push({ from: env.from, to: env.to, hop: env.hop, ms });
    return { status: 200, body: { v: 1, trace_id, hop: env.hop, hops_used: env.hop + 1, text: r.text, truncated: false, usage: { ms, tokens_est: r.tokens_est } } };
  } catch (e) {
    const code = e.code || "PEER_CRASH";
    const status = code === "HOP_LIMIT" ? 429 : code === "TIMEOUT" || code === "CANCELLED" ? 504 : 502;
    return { status, body: { error: String(e.message).slice(0, 500), code, trace_id, hops_used: env.hop } };
  } finally { clearTimeout(timer); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname.startsWith("/ask/")) {
    const peer = url.pathname.split("/")[2];
    if (peer !== "pi" && peer !== "claude") { res.writeHead(404); res.end('{"error":"unknown peer"}'); return; }
    let raw = "";
    for await (const c of req) raw += c;
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { res.writeHead(400); res.end('{"error":"BAD_JSON","code":"BAD_JSON"}'); return; }
    const out = await handleAsk(peer, body);
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/traces/")) {
    const id = decodeURIComponent(url.pathname.split("/")[2] || "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ trace_id: id, hops: traces.get(id) || [] }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") { res.writeHead(200); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end('{"error":"not found"}');
});

server.listen(PORT, "127.0.0.1", () => log(`listening 127.0.0.1:${PORT} mode=${REAL ? "REAL" : "MOCK"}`));
