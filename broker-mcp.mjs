#!/usr/bin/env node
// Minimal MCP stdio server exposing ask_pi. Stdlib only.
// Speaks JSON-RPC: initialize, tools/list, tools/call.
import http from "node:http";

const BROKER = process.env.BRIDGE_URL || "http://127.0.0.1:3939";
let buf = "";

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(BROKER + path);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.end(data);
  });
}

async function handleAskPi(args) {
  const r = await post("/ask/pi", { prompt: args.prompt, trace_id: args.trace_id, hop: args.hop ?? 0, max_hops: args.max_hops ?? 3, deadline_ms: args.maxMs ?? args.deadline_ms ?? 60000, from: "claude" });
  if (r.status !== 200) throw new Error(`${r.json.code || "PEER_ERROR"}: ${r.json.error || "failed"}`);
  return r.json.text;
}

const TOOLS = [{ name: "ask_pi", description: "Ask Pi agent (hop-limited, via broker). Use for work Pi does better; keep prompts self-contained.", inputSchema: { type: "object", properties: { prompt: { type: "string" }, maxMs: { type: "number" }, trace_id: { type: "string" }, hop: { type: "number" } }, required: ["prompt"] } }];

async function dispatch(msg) {
  if (msg.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "claude-pi-bridge", version: "0.1.0" } };
  if (msg.method === "tools/list") return { tools: TOOLS };
  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params || {};
    if (name !== "ask_pi") throw new Error("unknown tool: " + name);
    const text = await handleAskPi(args || {});
    return { content: [{ type: "text", text }] };
  }
  throw new Error("unknown method: " + msg.method);
}

process.stdin.on("data", async (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    try {
      const result = await dispatch(msg);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result }) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32000, message: String(e.message).slice(0, 500) } }) + "\n");
    }
  }
});
