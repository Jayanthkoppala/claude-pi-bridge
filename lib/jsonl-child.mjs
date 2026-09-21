import { spawn } from "node:child_process";
import { splitLF } from "./envelope.mjs";

// Persistent JSONL child: spawn once, send objects, resolve by id.
// Used for pi --mode rpc. Claude uses same framing via stream-json stdin.
export function makeJsonlChild(cmd, args, { onEvent } = {}) {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pending = new Map(); // id -> {resolve, reject, timer, responses}
  let seq = 0;

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const { lines, rest } = splitLF(buf);
    buf = rest;
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      // RPC response correlation
      if (msg.type === "response" && msg.id && pending.has(msg.id)) {
        pending.get(msg.id).response = msg;
        // pi emits response on accept, real result arrives via agent_settled — don't resolve yet for prompt
        if (msg.command !== "prompt") finish(msg.id, msg);
      }
      if (onEvent) onEvent(msg, { finish, child });
    }
  });
  function finish(id, val) {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(val);
  }
  function send(obj, { timeoutMs = 120000 } = {}) {
    const id = obj.id || `r_${Date.now().toString(36)}_${seq++}`;
    const withId = { ...obj, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" })); }, timeoutMs);
      pending.set(id, { resolve, reject, timer, response: null });
      child.stdin.write(JSON.stringify(withId) + "\n");
    });
  }
  function kill() { try { child.kill("SIGTERM"); setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000); } catch {} }
  return { child, send, finish, pending, kill };
}
