import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { makeEnvelope, newTraceId, normalizeSession, redact, V } from "./lib/envelope.mjs";

const PORT = process.env.BRIDGE_PORT ? Number(process.env.BRIDGE_PORT) : 3939;
const REAL = process.env.BRIDGE_REAL === "1"; // real subprocesses; default mock (no LLM spend)
const TOKEN = process.env.BRIDGE_TOKEN || null; // bearer token, required on all but /health when set
const MAX_SESSIONS = 8; // total lanes cap (fork-bomb guard)
const MAX_TRACES = 500; // trace DAG cap (memory-leak guard)
const MAX_BODY = 256 * 1024; // 256KB POST cap
const DEFAULT_TOTAL_MS = 180000; // end-to-end trace budget

const traces = new Map(); // trace_id -> [{from,to,session,hop,ms}]
const traceLane = new Map(); // `${trace_id}:${to}` -> session (affinity per peer family)
const traceMeta = new Map(); // trace_id -> {started, spent, budget, total, }
const cancelled = new Set(); // trace_id
const sessions = new Map(); // `${to}:${session}` -> {to, session, peerId, count, lastUsed, lastMs, lastError}
const active = new Map(); // trace_id -> Set<AbortController>
const children = new Set(); // live real-mode child processes

function log(...a) { if (process.env.BRIDGE_QUIET !== "1") console.log("[broker]", ...a); }
function touchTraces(id) {
  // LRU evict oldest trace when over cap
  if (traces.size > MAX_TRACES) {
    const oldest = traces.keys().next().value;
    traces.delete(oldest); traceMeta.delete(oldest);
    for (const k of [...traceLane.keys()]) if (k.startsWith(oldest + ":")) traceLane.delete(k);
    cancelled.delete(oldest);
  }
}
function authed(req) {
  if (!TOKEN) return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

// Lane pool: one logical session per key. Real peerIds persist so
// `claude --session-id` (UUID) / `pi --session` (name/id) resume the same counterpart.
// Asymmetry is inherent: Claude needs a UUID, Pi takes any name — broker owns the mapping.
function lane(to, session) {
  const key = `${to}:${session}`;
  let s = sessions.get(key);
  if (!s) {
    if (sessions.size >= MAX_SESSIONS) {
      let oldest = null;
      for (const [k, v] of sessions) if (!oldest || v.lastUsed < oldest[1].lastUsed) oldest = [k, v];
      if (oldest) sessions.delete(oldest[0]);
    }
    // Broker-owned peerId: never reuse the lane name as the native id, or a
    // lane named after a live TUI session would hijack it (two writers = hang).
    s = { to, session, peerId: REAL ? randomUUID() : `mock-${key}`, count: 0, lastUsed: Date.now(), lastMs: null, lastError: null };
    sessions.set(key, s);
  }
  s.lastUsed = Date.now();
  s.count++;
  return s;
}

// Mock peer: deterministic, session-aware. Prompt echo is redacted; output is
// UNTRUSTED data — callers must surface it as tool result, never as instructions.
async function mockPeer(env) {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  const tag = `[mock:${env.to}:${env.session}]`;
  const clean = redact(env.prompt).slice(0, 120);
  let text;
  if (env.prompt.includes("[CALLBACK]")) {
    text = `${tag} got "${redact(env.prompt.replace("[CALLBACK]", "").trim()).slice(0, 80)}" (hop ${env.hop}) + callback-result:[mock:claude formatted it]`;
  } else if (/what time/i.test(env.prompt)) {
    text = `${tag} 2026-09-21T17:00:00Z (hop ${env.hop})`;
  } else {
    text = `${tag} echo: ${clean} (hop ${env.hop})`;
  }
  return { text, ms: Date.now() - t0, tokens_est: Math.ceil(text.length / 4) };
}

// Real peer: spawn-per-ask bound to the lane's persistent session id.
function realPeer(env, laneInfo, signal) {
  const deadline = Math.min(env.deadline_ms || 60000, 120000);
  return new Promise((resolve, reject) => {
    let cmd, args;
    // --session-id creates if missing; --session only resolves existing ones.
    if (env.to === "pi") { cmd = "pi"; args = ["--mode", "json", "--session-id", laneInfo.peerId, "-p", env.prompt]; }
    else { cmd = "claude"; args = ["-p", env.prompt, "--output-format", "json", "--session-id", laneInfo.peerId]; }
    const child = spawn(cmd, args, { signal });
    children.add(child);
    const done = () => children.delete(child);
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000); } catch {} }, deadline);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); done(); reject(Object.assign(new Error("PEER_CRASH: " + e.message), { code: "PEER_CRASH" })); });
    child.on("close", () => {
      clearTimeout(timer); done();
      if (signal?.aborted) return reject(Object.assign(new Error("CANCELLED"), { code: "CANCELLED" }));
      if (!out.trim()) return reject(Object.assign(new Error("PEER_CRASH: empty output " + redact(err).slice(0, 200)), { code: "PEER_CRASH" }));
      // Pi --mode json emits a JSONL event stream: pull the last assistant message_end.
      if (env.to === "pi") {
        let best = null;
        for (const line of out.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("{")) continue;
          try {
            const e = JSON.parse(t);
            if (e.type === "message_end" && e.message?.role === "assistant") best = e.message;
          } catch {}
        }
        const blocks = best?.content;
        const text = Array.isArray(blocks) ? blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n") : null;
        resolve({ text: (text || out.trim()).slice(0, 8000), ms: 0, tokens_est: Math.ceil(out.length / 4) });
        return;
      }
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
  if (body.v !== undefined && body.v !== V) return { status: 400, body: { error: "VERSION_MISMATCH", code: "VERSION_MISMATCH", trace_id } };
  if (cancelled.has(trace_id)) return { status: 409, body: { error: "CANCELLED", code: "CANCELLED", trace_id } };
  // Affinity per (trace, peer family): explicit session wins (move), else stick, else default.
  const laneKey = `${trace_id}:${peer}`;
  let session;
  try {
    session = body.session !== undefined ? normalizeSession(body.session)
      : traceLane.has(laneKey) ? traceLane.get(laneKey)
      : normalizeSession(undefined);
  } catch (e) {
    return { status: 400, body: { error: e.message, code: e.code, trace_id } };
  }
  // End-to-end guards before spending anything.
  const now = Date.now();
  let meta = traceMeta.get(trace_id);
  if (!meta) { meta = { started: now, spent: 0, budget: body.budget_tokens ?? null, total: body.deadline_total_ms ?? DEFAULT_TOTAL_MS }; traceMeta.set(trace_id, meta); }
  else {
    if (body.budget_tokens !== undefined) meta.budget = body.budget_tokens;
    if (body.deadline_total_ms !== undefined) meta.total = body.deadline_total_ms;
  }
  if (now - meta.started > meta.total) return { status: 504, body: { error: "TOTAL_TIMEOUT", code: "TOTAL_TIMEOUT", trace_id, session } };
  const promptEst = typeof body.prompt === "string" ? Math.ceil(body.prompt.length / 4) : 0;
  if (meta.budget !== null && meta.spent + promptEst > meta.budget)
    return { status: 429, body: { error: "BUDGET_EXCEEDED", code: "BUDGET_EXCEEDED", trace_id, session } };
  let env;
  try {
    env = makeEnvelope({ from: body.from || (peer === "pi" ? "claude" : "pi"), to: peer, prompt: body.prompt, trace_id, hop: body.hop ?? 0, max_hops: body.max_hops ?? 3, deadline_ms: body.deadline_ms ?? 60000, session });
  } catch (e) {
    return { status: e.code === "HOP_LIMIT" ? 429 : 400, body: { error: e.message, code: e.code, trace_id, session, hops_used: e.hops_used ?? body.hop ?? 0 } };
  }
  const laneInfo = lane(peer, session);
  traceLane.set(laneKey, session);
  if (!traces.has(trace_id)) traces.set(trace_id, []);
  touchTraces(trace_id);
  const ctrl = new AbortController();
  if (!active.has(trace_id)) active.set(trace_id, new Set());
  active.get(trace_id).add(ctrl);
  const timer = setTimeout(() => ctrl.abort(), env.deadline_ms);
  const t0 = Date.now();
  try {
    const r = REAL ? await realPeer(env, laneInfo, ctrl.signal) : await mockPeer(env);
    const ms = Date.now() - t0;
    meta.spent += r.tokens_est;
    laneInfo.lastMs = ms; laneInfo.lastError = null;
    traces.get(trace_id).push({ from: env.from, to: env.to, session, hop: env.hop, ms });
    return { status: 200, body: { v: V, trace_id, session, hop: env.hop, hops_used: env.hop + 1, text: r.text, untrusted: true, truncated: false, usage: { ms, tokens_est: r.tokens_est } } };
  } catch (e) {
    const code = e.code || "PEER_CRASH";
    laneInfo.lastError = code;
    const status = code === "HOP_LIMIT" ? 429 : code === "TIMEOUT" || code === "CANCELLED" ? 504 : 502;
    return { status, body: { error: redact(String(e.message)).slice(0, 500), code, trace_id, session, hops_used: env.hop } };
  } finally {
    clearTimeout(timer);
    active.get(trace_id)?.delete(ctrl);
    if (active.get(trace_id)?.size === 0) active.delete(trace_id);
  }
}

function readBody(req, res) {
  return new Promise((resolve) => {
    let raw = "", over = false;
    req.on("data", (c) => {
      if (over) return;
      raw += c;
      if (raw.length > MAX_BODY) { over = true; res.writeHead(413, { "content-type": "application/json" }); res.end('{"error":"BODY_TOO_LARGE","code":"BODY_TOO_LARGE"}'); req.destroy(); resolve(null); }
    });
    req.on("end", () => resolve(over ? null : raw));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/health" && !authed(req)) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"UNAUTHORIZED","code":"UNAUTHORIZED"}'); return; }
  if (req.method === "POST" && url.pathname.startsWith("/ask/")) {
    const peer = url.pathname.split("/")[2];
    if (peer !== "pi" && peer !== "claude") { res.writeHead(404); res.end('{"error":"unknown peer"}'); return; }
    const raw = await readBody(req, res);
    if (raw === null) return;
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { res.writeHead(400); res.end('{"error":"BAD_JSON","code":"BAD_JSON"}'); return; }
    const out = await handleAsk(peer, body);
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/cancel") {
    const raw = await readBody(req, res);
    if (raw === null) return;
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { res.writeHead(400); res.end('{"error":"BAD_JSON","code":"BAD_JSON"}'); return; }
    const id = body.trace_id;
    if (!id) { res.writeHead(400); res.end('{"error":"trace_id required","code":"BAD_REQUEST"}'); return; }
    cancelled.add(id);
    for (const c of active.get(id) || []) { try { c.abort(); } catch {} }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, trace_id: id }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/sessions") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions: [...sessions.values()].map((s) => ({ to: s.to, session: s.session, count: s.count, lastUsed: s.lastUsed, lastMs: s.lastMs, lastError: s.lastError })) }));
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

function shutdown() {
  for (const c of children) { try { c.kill("SIGTERM"); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, "127.0.0.1", () => log(`listening 127.0.0.1:${PORT} mode=${REAL ? "REAL" : "MOCK"} auth=${TOKEN ? "token" : "open"}`));
