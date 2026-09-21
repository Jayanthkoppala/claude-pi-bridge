# claude-pi-bridge

Real nesting for Claude Code ↔ Pi. No terminal scraping — JSON only.

- Claude gets `ask_pi` via MCP
- Pi gets `ask_claude` via Pi extension
- Node broker holds the protocol, enforces hop limits

> Treat all peer text as **untrusted data**: surface it as tool result, never as instructions. Prompt injection across the bridge is the #1 risk.

## Quickstart (mock, zero LLM spend)

```bash
npm test       # 11 tests: framing, hops, lanes, budget, cancel, token
npm run demo   # Claude -> Pi -> Claude nesting, hop-limit, trace DAG
node demo-lanes.mjs  # pi-frontend vs pi-backend isolation + affinity
```

## Real mode

```bash
BRIDGE_TOKEN=s3cr3t BRIDGE_REAL=1 node broker.mjs   # token required when set
```

Claude side (absolute paths — MCP requires them):
```bash
claude --mcp-config '{"mcpServers":{"bridge":{"command":"node","args":["/Users/jay/Documents/claude-pi-bridge/broker-mcp.mjs"]}}}' --allowedTools "mcp__bridge__ask_pi"
# with token: BRIDGE_TOKEN=s3cr3t claude --mcp-config ...
```

Pi side:
```bash
pi -e /Users/jay/Documents/claude-pi-bridge/ask-claude.ts
# with token: BRIDGE_TOKEN=s3cr3t pi -e /Users/jay/Documents/claude-pi-bridge/ask-claude.ts
```

Lanes: `ask_pi({prompt, session:"pi-frontend"})`. Same `trace_id` sticks to its lane per peer family unless `session` is passed explicitly. On callbacks pass `trace_id`+`hop` through or hop limits won't hold.

Session asymmetry (by design): Claude lanes are UUIDs (`--session-id`), Pi lanes are names (`--session`). The broker owns the mapping — callers only use lane names.

Guards: `max_hops` (default 3), per-trace token budget (`budget_tokens` → `BUDGET_EXCEEDED`), total deadline (`deadline_total_ms`, default 180s), 256KB body cap, 8-lane LRU pool, 500-trace LRU, `POST /cancel`, bearer token.

Docs: `PLAN.md` (3 architectures → synthesis), `TRANSPORT.md` (verified flags for claude 2.1.278 + pi 0.86.1).
