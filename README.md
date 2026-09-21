# claude-pi-bridge

Real nesting for Claude Code ↔ Pi. No terminal scraping — JSON only.

- Claude gets `ask_pi` via MCP
- Pi gets `ask_claude` via Pi extension
- Node broker holds the protocol, enforces hop limits

## Quickstart (mock, zero LLM spend)

```bash
npm test       # 5 tests: framing, hops, broker, MCP
npm run demo   # Claude -> Pi -> Claude nesting, hop-limit, trace DAG
```

## Real mode

```bash
BRIDGE_REAL=1 node broker.mjs            # stateless spawn-per-ask (Design C)
claude mcp add bridge -- node ./broker-mcp.mjs   # Claude side: ask_pi
pi -e ./ask-claude.ts                   # Pi side: ask_claude
```

MCP via flag instead:
```bash
claude -p --input-format stream-json --output-format stream-json \
  --mcp-config '{"mcpServers":{"bridge":{"command":"node","args":["./broker-mcp.mjs"]}}}' \
  --strict-mcp-config
```

Docs: `PLAN.md` (3 architectures → synthesis), `TRANSPORT.md` (verified flags for claude 2.1.278 + pi 0.86.1).
