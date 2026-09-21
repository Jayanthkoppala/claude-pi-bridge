# TRANSPORT.md — Phase 0 verification (no LLM spend)

Verified 2026-09-21 on this Mac. Sources: `claude --help`, `claude mcp --help`, `pi --help`, pi docs `rpc.md` + `extensions.md`, live `pi --mode rpc get_state` smoke test.

## Claude Code — 2.1.278

Stream JSON both ways, no scraping:

```bash
# One-shot with structured events
claude -p "hello" --output-format stream-json

# Full duplex (this is the bridge transport)
claude -p --input-format stream-json --output-format stream-json \
  --mcp-config '{"mcpServers":{"bridge":{"command":"node","args":["./broker.mjs"]}}}' \
  --strict-mcp-config \
  --session-id 11111111-2222-4333-8333-444444444444 \
  --replay-user-messages
```

Notes:
- `--input-format stream-json` + `--output-format stream-json` only work with `--print`.
- `--replay-user-messages` echoes stdin back on stdout for ack (needed for broker framing).
- `--include-partial-messages` for token streaming (defer to v1).
- `--resume <session-id>` / `--continue` re-attaches; broker should pin `--session-id` (must be UUID).
- MCP add (alternative to --mcp-config file):
  `claude mcp add bridge -- node ./broker-mcp.mjs`
  `claude mcp add-json bridge '{"command":"node","args":["./broker-mjs"]}'`
- SDK option (v1, not v0): `@anthropic-ai/claude-agent-sdk@0.3.278` `query()` iterator. Use CLI for v0 to avoid dep.

NOT live-tested (saves credits): actual stdin loop with tool call. Command above is copy-paste ready.

## Pi — 0.86.1

RPC over strict JSONL, LF only:

```bash
pi --mode rpc --no-session
pi --mode rpc -e ./ask-claude.ts --session-dir ./sessions
```

Smoke-tested live:
```python
proc = Popen(["pi","--mode","rpc","--no-session"], stdin=PIPE, stdout=PIPE)
send({"type":"get_state"}) ->
{"type":"response","command":"get_state","success":true,"data":{model, thinkingLevel, sessionId, ...}}
```
Works. Also emits `extension_ui_request` (setStatus/notify) — broker must ignore/fire-and-forget, only answer dialog methods.

Protocol rules for broker (from rpc.md):
- Split stdout on `\n` only. Strip trailing `\r`. Never use Node `readline` (splits U+2028/U+2029 inside strings).
- Commands broker needs: `prompt {message, streamingBehavior?}`, `steer`, `follow_up`, `abort`, `get_state`, `get_last_assistant_text`, `get_session_stats`.
- If streaming and no `streamingBehavior`, `prompt` errors — broker sends `steer` when busy, `follow_up` when finishing.
- Wait for `agent_settled` (not just `agent_end`) before returning `ask_pi` result.
- Events to parse: `message_update` (text_delta), `tool_execution_start/end`, `agent_end`, `agent_settled`, `extension_error`.

Extension (`ask_claude` tool for Pi side) — shape verified from `dynamic-tools.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI){
  pi.registerTool({
    name: "ask_claude",
    description: "Ask Claude Code, hop-limited. prompt + maxMs.",
    parameters: Type.Object({ prompt: Type.String(), maxMs: Type.Optional(Type.Number()) }),
    async execute(_id, params){
      const text = await askBroker({ to:"claude", prompt: params.prompt, maxMs: params.maxMs ?? 60000 });
      return { content: [{ type:"text", text }], details:{} };
    }
  });
}
```
Load: `pi -e ./ask-claude.ts` for test, `~/.pi/agent/extensions/` for real.

## Broker implications (locks for Phase 1)

1. Node stdlib only. Custom JSONL splitter (not readline).
2. Spawn both once, hold open. Claude via `--input-format stream-json`, Pi via `--mode rpc`.
3. MCP `ask_pi` = translate `tools/call` → Pi `prompt` → wait `agent_settled` → `get_last_assistant_text` → MCP return.
4. Pi `ask_claude` = HTTP/pipe to broker → Claude stdin JSON → parse `stream-json` until turn end.
5. Hop/deadline enforced in broker only. Kill = SIGTERM→SIGKILL, return `{error:TIMEOUT|HOP_LIMIT}`.

Open for Phase 1: exact Claude stream-json input record shape (`{type:user,message:{role,content}}`) — copy from `--replay-user-messages` output on first run.
