import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { makeEnvelope, newTraceId, normalizeSession, redact } from "./lib/envelope.mjs";

const PORT = process.env.BRIDGE_PORT ? Number(process.env.BRIDGE_PORT) : 3939;
const REAL = process.env.BRIDGE_REAL === "1"; // real subprocesses; default mock (no LLM spend)
const MAX_SESSIONS = 8; // total lanes cap (fork-bomb guard)
const traces = new Map(); // trace_id -> [{from,to,session,hop,ms}]
const traceSession = new Map(); // trace_id -> session (affinity: stick unless explicitly moved)
const sessions = new Map(); // `${to}:${session}` -> {to, session, peerId, count, lastUsed}

function log(...a) { if (process.env.BRIDGE_QUIET !== "1") console.log("[broker]", ...a); }

// Lane pool: one logical session per key. Real peerIds persist so
// `claude --session-id` / `pi --session` resume the same counterpart.
function lane(to, session) {
  const key = `${to}:${session}`;
  let s = sessions.get(key);
  if (!s) {
    if (sessions.size >= MAX_SESSIONS) {
      // LRU evict
      let oldest = null;
      for (const [k, v] of sessions) if (!oldest || v.lastUsed < oldest[1].lastUsed) oldest = [k, v];
      if (oldest) sessions.delete(oldest[0]);
    }
    let peerId;
    if (REAL) {
      if (to === "claude") {
        try { execSync("uuidgen", { stdio: ["ignore", "pipe", "ignore"] }); peerId = randomUUID(); }
        catch { peerId = randomUUID(); }
      } else peerId = session; // pi --session accepts name/id
    } else peerId = `mock-${key}`;
    s = { to, session, peerId, count: 0, lastUsed: Date.now() };
    sessions.set(key, s);
  }
  s.lastUsed = Date.now();
  s.count++;
  return s;
}

// Mock peer: deterministic, session-aware (proves routing without LLM spend).
async function mockPeer(env) {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  const tag = `[mock:${env.to}:${env.session}]`;
  let text;
  if (env.prompt.includes("[CALLBACK]")) {
    const inner = env.prompt.replace("[CALLBACK]", "").trim();
    text = `${tag} got "${inner.slice(0, 80)}" (hop ${env.hop}) + callback-result:[mock:claude formatted it]`;
  } else if (/what time/i.test(env.prompt)) {
    text = `${tag} 2026-09-21T17:00:00Z (hop ${env.hop})`;
  } else {
    text = `${tag} echo: ${env.prompt.slice(0, 120)} (hop ${env.hop})`;
  }
  return { text, ms: Date.now() - t0, tokens_est: Math.ceil(text.length / 4) };
}

// Real peer: spawn-per-ask bound to the lane's persistent session id.
function realPeer(env, laneInfo, signal) {
  const deadline = Math.min(env.deadline_ms || 60000, 120000);
  return new Promise((resolve, reject) => {
    let cmd, args;
    if (env.to === "pi") { cmd = "pi"; args = ["--mode", "json", "--session", laneInfo.peerId, "-p", env.prompt]; }
    else { cmd = "claude"; args = ["-p", env.prompt, "--output-format", "json", "--session-id", laneInfo.peerId]; }
    const child = spawn(cmd, args, { signal });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000); } catch {} }, deadline);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(Object.assign(new Error("PEER_CRASH: " + e.message), { code: "PEER_CRASH" })); });
    child.on("close", () => {
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
  // Affinity: explicit session wins (move), else stick to trace's lane, else default.
  let session;
  try {
    session = body.session !== undefined ? normalizeSession(body.session)
      : traceSession.has(trace_id) ? traceSession.get(trace_id)
      : normalizeSession(undefined);
  } catch (e) {
    return { status: 400, body: { error: e.message, code: e.code, trace_id } };
  }
  let env;
  try {
    env = makeEnvelope({ from: body.from || (peer === "pi" ? "claude" : "pi"), to: peer, prompt: body.prompt, trace_id, hop: body.hop ?? 0, max_hops: body.max_hops ?? 3, deadline_ms: body.deadline_ms ?? 60000, session });
  } catch (e) {
    return { status: e.code === "HOP_LIMIT" ? 429 : 400, body: { error: e.message, code: e.code, trace_id, hops_used: e.hops_used ?? body.hop ?? 0 } };
  }
  const laneInfo = lane(peer, session);
  traceSession.set(trace_id, session);
  if (!traces.has(trace_id)) traces.set(trace_id, []);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), env.deadline_ms);
  const t0 = Date.now();
  try {
    const r = REAL ? await realPeer(env, laneInfo, ctrl.signal) : await mockPeer(env);
    const ms = Date.now() - t0;
    traces.get(trace_id).push({ from: env.from, to: env.to, session, hop: env.hop, ms });
    return { status: 200, body: { v: 1, trace_id, session, hop: env.hop, hops_used: env.hop + 1, text: r.text, truncated: false, usage: { ms, tokens_est: r.tokens_est } } };
  } catch (e) {
    const code = e.code || "PEER_CRASH";
    const status = code === "HOP_LIMIT" ? 429 : code === "TIMEOUT" || code === "CANCELLED" ? 504 : 502;
    return { status, body: { error: String(e.message).slice(0, 500), code, trace_id, session, hops_used: env.hop } };
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
  if (req.method === "GET" && url.pathname === "/sessions") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions: [...sessions.values()].map((s) => ({ to: s.to, session: s.session, count: s.count, lastUsed: s.lastUsed })) }));
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
