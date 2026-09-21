# claude-pi-bridge

Real nesting for Claude Code ↔ Pi. No terminal scraping — JSON only.

- Claude gets `ask_pi` via MCP
- Pi gets `ask_claude` via Pi extension
- Node broker holds both sessions open, enforces hop limits

See `PLAN.md` for the deep design (3 architectures compared, synthesis = narrow-waist broker).

Quickstart (coming in Phase 1):
```bash
npm install
npm run demo
```
