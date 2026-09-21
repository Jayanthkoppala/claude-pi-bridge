# claude-pi-bridge — PLAN

Status: plan v0.1 (no code yet). Goal: real nesting Claude Code ↔ Pi in JSON, no terminal scraping.

## 1. What this Module solves

Keep two long-lived sessions open (Claude Code + Pi RPC) behind a tiny Node broker. Each side gets one tool to call the other:

- Claude gets `ask_pi` via MCP
- Pi gets `ask_claude` via Pi extension

Callers get recursion: Claude → Pi → Claude → return, with hop limits, budgets, and trace.

Non-goals for v0: streaming partials, multi-session fan-out, auth, persistence.

## 2. Requirements

- [ ] Machine JSON both ways, never scrape terminal text
- [ ] Both sessions stay open (no spawn-per-ask in v0 final, though Design C starts there)
- [ ] Exactly one new tool per side to learn
- [ ] Nesting works both directions with termination guarantee
- [ ] Timeouts + token/cost budgets enforced in one place
- [ ] Local-first, zero deps beyond Node stdlib for v0 broker
- [ ] Public OSS from day 1: README, MIT, .gitignore, no secrets

Callers: Claude agent (via MCP), Pi agent (via extension), human dev (CLI/curl for debug).
Key ops: `ask(other, prompt, budget)` + `cancel(trace_id)` (debug only).
Constraints: Node 20+, stdlib-only v0, localhost only, 1 Claude session + 1 Pi session.

## 3. Transports to verify (Phase 0, before code)

- Claude Code: `claude -p --output-format stream-json --input-format stream-json` keeps stdin open for follow-ups? Or SDK `@anthropic-ai/claude-agent-sdk` with `query()` async iterator? Verify which supports mid-session tool injection for `ask_pi`.
- Pi: `pi --rpc` mode wire format? Verify: stdio JSON-RPC vs websocket, method names for `run/prompt`, extension manifest for `ask_claude`.
- MCP: broker exposes `tools/list` + `tools/call ask_pi`. Verify Claude Code MCP server config shape.

If either transport can't hold a session, fall back to Design C (ephemeral spawn).

## 4. Three radically different designs

### Design A — Narrow waist (minimize methods, 1-2 max)

> Agent 1 brief: smallest interface that could work.

```ts
// broker is the only Module with depth. Claude/Pi see this:
type AskInput = { prompt: string; budget?: { maxMs?: number; maxTokens?: number }; hop?: number };
type AskOutput = { text: string; trace_id: string; hops_used: number; truncated: boolean };

// MCP (Claude side): tools/call ask_pi { prompt, budget }
// Pi extension (Pi side): ask_claude { prompt, budget }
```

Usage:

```json
// Claude calls Pi
{ "tool": "ask_pi", "input": { "prompt": "refactor auth.ts, return diff only", "budget": { "maxMs": 60000 } } }
// Pi calls back (same envelope, opposite direction)
{ "tool": "ask_claude", "input": { "prompt": "confirm error schema?", "budget": { "maxMs": 20000 } } }
```

Hides inside broker: child process lifecycle, JSONL framing, trace_id gen, hop counter, timeout kill, token estimate, logs.
Trade-offs: + easiest to learn, hardest to misuse, deep Module. − no streaming, no session picker, no capability negotiation. Upgrades need broker change.

### Design B — Bus (maximize flexibility)

> Agent 2 brief: support every future use case.

```ts
bus.sessions.list() -> Session[]
bus.sessions.spawn(kind: "claude"|"pi", opts) -> Session
bus.tools.call(session_id, tool, input, { trace_id, deadline, budget }) -> EventStream
bus.capabilities.register(session_id, tools[]) 
bus.traces.get(trace_id) -> DAG of hops
```

Usage: caller picks session, subscribes to partial events, registers new tools at runtime.
Hides: little — caller manages sessions, DAG, backpressure.
Trade-offs: + future-proof, observable. − shallow (large Interface, thin Implementation), easy to misuse (leaked sessions, fork bombs), 5x test surface. Violates depth.

### Design C — Stateless relay (optimize common case)

> Agent 3 brief: no daemon, each ask = fresh subprocess.

```ts
// No broker process. Just:
POST /ask/:peer { prompt, budget } -> { text }
// impl: spawn(`claude -p` | `pi --rpc-once`), wait, return, exit
```

Usage: `curl localhost:3939/ask/pi -d '{"prompt":"..."}'`. MCP wrapper and Pi extension are thin HTTP clients.
Hides: almost nothing — process spawn is the implementation.
Trade-offs: + zero state, trivial to build/debug, no lifecycle bugs. − slow (cold start per hop), no real nesting (child can't call back without parent URL), costs balloon, timeouts flaky. Good as Phase 1 stepping stone, wrong as final.

## 5. Comparison

Design A wins on depth: 1 method to learn, all hard stuff (framing, hops, kill, budgets) has locality in the broker. Deletion test passes — delete broker and every caller re-implements framing + recursion guards.

Design B is powerful but shallow: pushes session/DAG management to callers who just want `ask(other, prompt)`. Keep its ideas (trace DAG, session list for debug) as debug-only endpoints, not the core Interface.

Design C is the laziest thing that works for one-way. Use it as Phase 1 to validate transports, then delete it once the persistent broker lands. Don't keep both.

Divergence point: where the Seam lives. A puts the Seam at `ask(peer,prompt)`; B puts it at the transport bus; C puts it at HTTP. A is the only one where the recursion guard has locality.

## 6. Synthesis — build A, steal debug tools from B, bootstrap with C

Core Interface (v0, frozen):

```ts
ask_pi({ prompt, maxMs?, maxTokens?, trace_id?, hop? }) -> { text, trace_id, hops_used, truncated }
ask_claude({ prompt, maxMs?, maxTokens?, trace_id?, hop? }) -> same
```

Envelope (JSONL on stdio, JSON over MCP/extension — same shape):

```json
{
  "v": 1,
  "trace_id": "t_abc",
  "parent_id": "t_abc:h0",
  "from": "claude",
  "to": "pi",
  "hop": 0,
  "max_hops": 3,
  "deadline_ms": 60000,
  "budget_tokens": 2000,
  "prompt": "..."
}
```

Response:

```json
{ "v": 1, "trace_id": "t_abc", "hop": 0, "text": "...", "truncated": false, "usage": { "ms": 1234, "tokens_est": 400 } }
```

Rules:
- `hop` increments each crossing. If `hop >= max_hops` (default 3), broker rejects with `HOP_LIMIT` error, no spawn.
- `trace_id` propagates. Same trace = same conversation. New trace = new budget.
- `deadline_ms` is wall-clock per hop, enforced by broker kill (SIGTERM→SIGKILL). Child timeout is never trusted.
- Same-process anti-echo: broker refuses `from == to` unless `allow_self` flag (debug only).
- Kill switch: `CANCEL { trace_id }` kills subtree.

```
┌──────────┐  MCP ask_pi   ┌────────┐  JSONL stdio  ┌───────┐
│ Claude   │ ◄─────────── │ Broker │ ◄──────────── │ Pi    │
│ Code     │ ───────────► │ (Node) │ ────────────► │ (RPC) │
└──────────┘  JSON return └────────┘  JSON return  └───────┘
       ▲                    │ ▲                    ▲
       └──── hop+trace ─────┘ └──── kill/budget ───┘
```

Broker internals (not part of Interface, swappable):
- `spawnClaude()`, `spawnPi()` adapters behind internal seam
- `framer` (JSONL split/parse), `hops` guard, `budgets` timer, `log` (JSONL file per trace)
- debug-only: `GET /traces/:id`, `POST /cancel`

Error modes (all callers must handle): `HOP_LIMIT`, `TIMEOUT`, `PEER_CRASH` (with restart once), `BAD_JSON`, `BUDGET_EXCEEDED`. All return `{ error, trace_id, hops_used }`, never hang.

Security: localhost bind only, no env passthrough except allowlist, 64KB prompt cap v0, log redaction for `sk-`/`gho_` patterns.

## 7. Build order

- Phase 0 (verify): confirm Claude stream-json stdin loop + Pi RPC spawn + MCP config. 1hr timebox. Output: TRANSPORT.md with exact commands.
- Phase 1 (C-then-A): stateless `POST /ask/:peer` with ephemeral spawn. Proves tools wiring end-to-end.
- Phase 2 (A core): persistent broker, `ask_pi` MCP server + `ask_claude` Pi extension, envelope + trace_id.
- Phase 3 (nesting): allow callbacks, add `max_hops=3`, cancel, anti-echo, crash-restart.
- Phase 4 (OSS harden): README demo gif, `npm run demo` (Claude asks Pi what time it is, Pi asks Claude to format it), tests: hop-limit test + timeout test + echo test. No frameworks — node:test only.

Kill criteria: if Phase 0 shows Pi RPC can't hold a session, ship C as v0 and document it.

## 8. Open questions

1. Claude transport: CLI stream-json vs SDK `query()` — which allows MCP tool injection mid-stream?
2. Pi RPC: stdio vs socket? Extension manifest filename?
3. Token accounting: estimate locally or trust peer usage fields?
4. Streaming: defer to v1, or needed for demo?

## 9. OSS checklist for live push

- [x] PLAN.md (this file)
- [ ] README.md with 10-line quickstart
- [ ] LICENSE (MIT), .gitignore (node_modules, traces/)
- [ ] package.json stdlib-only, `node --test`
- [ ] No secrets in git log (scan for sk-/gho-/tokens before `gh repo create --public`)
