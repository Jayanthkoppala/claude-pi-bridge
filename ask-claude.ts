import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BROKER = process.env.BRIDGE_URL || "http://127.0.0.1:3939";

async function askBroker(to: "claude" | "pi", prompt: string, maxMs = 60000, trace_id?: string, hop = 0, session = "default"): Promise<string> {
  const res = await fetch(`${BROKER}/ask/${to}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, maxMs, trace_id, hop, session, from: to === "claude" ? "pi" : "claude" }),
    signal: AbortSignal.timeout(maxMs + 5000),
  });
  const json = (await res.json()) as { text?: string; error?: string; code?: string };
  if (!res.ok) throw new Error(`${json.code || "PEER_ERROR"}: ${json.error || "failed"}`);
  return json.text || "";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_claude",
    label: "Ask Claude",
    description: "Ask Claude Code via bridge broker (hop-limited). Keep prompts self-contained.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained prompt for Claude" }),
      maxMs: Type.Optional(Type.Number({ description: "Per-hop timeout ms" })),
      session: Type.Optional(Type.String({ description: "Claude lane (default \"default\")" })),
    }),
    async execute(_toolCallId, params) {
      const text = await askBroker("claude", params.prompt, params.maxMs ?? 60000, undefined, 0, params.session ?? "default");
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
