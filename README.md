# team-mem — Shared Team Memory for Claude Code

One connected memory for every Claude Code agent on the team.

Each of us runs Claude Code on our own machine, and each agent only knows what
its own person is doing. team-mem gives all of our agents a **shared,
per-project memory**: whatever one person's Claude does or learns on a team
project, everyone else's Claude can see — automatically.

> *"What is Yameen's Claude working on right now? How does his new auth flow
> work?"* — answerable from anyone's Claude, any time, even with Yameen's
> machine off.

## How it works

Think **[claude-mem](https://github.com/thedotmack/claude-mem), but for the
whole team at once** — with the "brain" moved to our always-on Mac Studio:

```
 Teammate's machine (× N)                     Mac Studio (Seoul, 24/7)
┌─────────────────────────────┐   Defguard   ┌──────────────────────────────────┐
│ Claude Code                 │     VPN      │  team-mem server (one process)   │
│  ├─ team-mem plugin (hooks) ┼── events ───▶│   ├─ ingest → SQLite + FTS5      │
│  │   └─ offline spool       │              │   ├─ LLM compression (glm-5.2)   │
│  └─ MCP client ─────────────┼── queries ──▶│   ├─ /context briefing           │
└─────────────────────────────┘              │   ├─ /mcp  (team_search, …)      │
                                             │   └─ /api  (l2u-work bot)        │
                                             └──────────────────────────────────┘
```

- **Capture** — a lightweight Claude Code plugin sends session events (prompts,
  tool activity, session summaries) to the central server. Hooks are
  fire-and-forget: they never slow down or break Claude Code, and they spool
  locally when the VPN is off.
- **Compression** — the server distills raw events into compact, typed
  *observations* ("decision", "change", "bug", "how-it-works") and per-session
  summaries, using the local glm-5.2 LLM already running on the Mac Studio.
  Zero API cost.
- **Recall** — every session starts with a compact team briefing ("since
  yesterday: Yameen changed the auth response shape in `web`…"), and MCP tools
  (`team_status`, `team_search`, `team_timeline`, `team_get`) answer deeper
  questions from any project.
- **Slack** — the same server exposes a read-only REST API on localhost, so
  the l2u-work bot can answer "@l2u-work what is Haseeb's Claude doing?" in
  Slack with no extra infrastructure.

## Privacy

Capture is **allowlist-only and enforced on the client**: only repos under our
company orgs (`mustfintech/*`, `must-desertsand/*`) are ever recorded. Anything
else — personal projects, other work, non-git directories — produces **zero
network traffic**: the hook exits before touching the network. Secret-shaped
content (keys, tokens, `.env` reads) is redacted on the client before it
leaves the machine, everyone can delete their own recorded sessions, and
`TEAM_MEM_OFF=1` is a full kill switch.

Inside a registered team project, everything captured is visible to the whole
team — that is the product.

## Status

**v1 implemented.** Server and plugin are both built and all tests are
green; deployment onto the Mac Studio is pending.

- Design spec: [`docs/superpowers/specs/2026-08-28-team-mem-design.md`](docs/superpowers/specs/2026-08-28-team-mem-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-08-28-team-mem.md`](docs/superpowers/plans/2026-08-28-team-mem.md)
- Setup guide: [`server/deploy/SETUP.md`](server/deploy/SETUP.md)

## Repository layout

```
server/    Bun + Hono + SQLite service that runs on the Mac Studio
plugin/    Claude Code plugin every teammate installs (zero-dependency hooks)
docs/      Design spec and implementation plan
```

## Setup

**Teammates** (each machine):

```bash
claude plugin marketplace add must-desertsand/Team-MCP-Claude-Mem
claude plugin install team-mem@must-desertsand
# then export TEAM_MEM_URL and TEAM_MEM_TOKEN in your shell profile
```

**Server** (Mac Studio, once): run under launchd on port 7337; nightly SQLite
backups. Full steps: [`server/deploy/SETUP.md`](server/deploy/SETUP.md).

## Roadmap after v1

Live agent-to-agent questions, scrum-board/task sync, semantic search, and a
read-only web activity feed — the v1 design leaves explicit doors open for
each (spec §14).

---

Built by the l2u team. Backend/initiative: Haseeb Zafar.
