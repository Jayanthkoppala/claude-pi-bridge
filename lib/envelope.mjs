export const V = 1;
export const DEFAULT_MAX_HOPS = 3;
export const DEFAULT_DEADLINE_MS = 60000;
export const MAX_PROMPT_CHARS = 64000;
export const DEFAULT_SESSION = "default";
export const MAX_SESSION_LEN = 64;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9-_:.]*$/;

export function normalizeSession(s) {
  const v = s ?? DEFAULT_SESSION;
  if (typeof v !== "string" || v.length > MAX_SESSION_LEN || !SESSION_RE.test(v))
    throw Object.assign(new Error("BAD_SESSION"), { code: "BAD_SESSION" });
  return v;
}

export function newTraceId(prefix = "t") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Strict JSONL split: LF only, strip single trailing \r. Never use readline.
export function splitLF(buffer) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === "\n") {
      let line = buffer.slice(start, i);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines.push(line);
      start = i + 1;
    }
  }
  return { lines, rest: buffer.slice(start) };
}

export function makeEnvelope({ from, to, prompt, trace_id, parent_id, hop = 0, max_hops = DEFAULT_MAX_HOPS, deadline_ms = DEFAULT_DEADLINE_MS, budget_tokens, session }) {
  if (!from || !to || typeof prompt !== "string") throw Object.assign(new Error("BAD_REQUEST"), { code: "BAD_REQUEST" });
  if (prompt.length > MAX_PROMPT_CHARS) throw Object.assign(new Error("PROMPT_TOO_LARGE"), { code: "PROMPT_TOO_LARGE" });
  if (from === to) throw Object.assign(new Error("ECHO_BLOCKED"), { code: "ECHO_BLOCKED" });
  if (hop >= max_hops) throw Object.assign(new Error("HOP_LIMIT"), { code: "HOP_LIMIT", hops_used: hop });
  return { v: V, trace_id: trace_id || newTraceId(), parent_id: parent_id || null, from, to, hop, max_hops, deadline_ms, budget_tokens: budget_tokens ?? null, session: normalizeSession(session), prompt };
}

export function nextHop(env) {
  if (env.hop + 1 >= env.max_hops) throw Object.assign(new Error("HOP_LIMIT"), { code: "HOP_LIMIT", hops_used: env.hop + 1 });
  return { ...env, parent_id: `${env.trace_id}:h${env.hop}`, hop: env.hop + 1 };
}

export function redact(s) {
  return String(s).replace(/sk-[A-Za-z0-9-_]{5,}/g, "sk-***").replace(/gho_[A-Za-z0-9_]{5,}/g, "gho_***");
}
