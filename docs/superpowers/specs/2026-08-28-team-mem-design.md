# team-mem — Shared Team Memory for Claude Code

**Date:** 2026-08-28
**Status:** Approved design, pre-implementation
**Repo:** `team-mcp-claude-mem` (mustfintech org)

## 1. Problem

Each team member (Haseeb — backend, Yameen — frontend, Dayan — lead/testing, plus
Seung Eun / Hoyoung) runs Claude Code on their own machine with their own context.
No agent sees what the others' agents are doing, so frontend/backend drift apart,
testing doesn't match what was built, and people re-explain the same things.

## 2. Goal

A shared memory service so that every teammate's Claude:

1. **Records** what it does and learns while working on team projects.
2. **Receives** a compact briefing of teammates' recent work at session start.
3. **Can answer** questions like "what is Yameen working on, and how does his auth
   flow work now?" from any machine, any time — even if Yameen's machine is off.

Explicit **non-goals for v1**: live agent-to-agent messaging, scrum-board/task
management, Slack bot code, semantic/vector search, web dashboard. (See §14 for
the doors we leave open.)

## 3. Decided constraints

| Decision | Choice |
| --- | --- |
| v1 scope | Shared memory only (Approach A: thin clients, central brain) |
| Server host | Mac Studio in Seoul, runs 24/7 (same machine as l2u-work bot) |
| Network | Company VPN (Defguard/WireGuard) — same path used to reach Seoul DBs |
| Compression LLM | Local glm-5.2 on the Mac Studio via OpenAI-compatible API; provider swappable |
| Slack | v1 exposes a REST query API that l2u-work can call; no Slack code here |
| Privacy | Capture is allowlist-only, enforced client-side (§5) |
| Storage | SQLite + FTS5, single file on the Mac Studio |
| Languages | TypeScript. Server runs on Bun; client hook scripts are zero-dependency Node (≥18) |

## 4. Architecture

```
 Teammate's machine (× N)                     Mac Studio (Seoul, 24/7)
┌─────────────────────────────┐   Defguard   ┌──────────────────────────────────┐
│ Claude Code                 │     VPN      │  team-mem server (one Bun process)│
│  ├─ team-mem plugin         │              │   ├─ HTTP API (Hono)             │
│  │   ├─ SessionStart hook ──┼── GET ──────▶│   │   ├─ /context   (briefing)   │
│  │   ├─ UserPromptSubmit ───┼── POST ─────▶│   │   ├─ /ingest    (events)     │
│  │   ├─ PostToolUse ────────┼── POST ─────▶│   │   ├─ /mcp       (MCP tools)  │
│  │   ├─ Stop ───────────────┼── POST ─────▶│   │   └─ /api/*     (REST)       │
│  │   └─ offline spool ──────┼─ flush ─────▶│   ├─ compression worker (poll)   │
│  └─ MCP client (http /mcp)  │              │   │    └─▶ glm-5.2 (local LLM)   │
└─────────────────────────────┘              │   └─ SQLite + FTS5               │
                                             │  l2u-work bot ──▶ /api/* (local) │
                                             └──────────────────────────────────┘
```

Monorepo layout:

```
team-mcp-claude-mem/
├── server/                 # Bun + Hono + bun:sqlite; the whole service
│   ├── src/
│   ├── deploy/             # launchd plist, backup script, setup notes
│   └── workspaces.json     # repo → workspace mapping (§8)
├── plugin/                 # Claude Code plugin (hooks + MCP + allowlist)
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json
│   ├── scripts/            # zero-dependency Node scripts
│   └── allowlist.json      # default include patterns
├── .claude-plugin/marketplace.json   # repo doubles as plugin marketplace
└── docs/
```

Design invariants:

- **Claude Code never breaks or slows.** Hooks fail silent with tight timeouts;
  send-hooks spawn a detached sender and exit in <50 ms.
- **Ingest path has no LLM.** One VPN round-trip: validate, insert, 200.
- **Nothing is lost within bounds.** Client spool when offline; raw events held
  server-side until compressed; compression retries.
- **Server down = today's behavior.** Sessions run normally, briefing absent.

## 5. Privacy model (capture boundary)

**Rule: work outside registered team projects never leaves the machine.**

- Every hook first resolves `git config --get remote.origin.url` from the session
  cwd and normalizes it to `owner/repo` (handles SSH host aliases like
  `github.com-company:mustfintech/x.git`, HTTPS, and `.git` suffixes).
- The result is matched against include patterns: `plugin/allowlist.json`
  (ships with `["mustfintech/*", "must-desertsand/*"]` — both company orgs, so
  work on team-mem itself is shared too; updated via plugin updates) merged
  with the user's local config. **No match → the hook exits immediately: no network call,
  no spool entry, nothing recorded.** Non-git directories never match.
- Local overrides in `~/.team-mem/config.json`:
  `{ "exclude": ["mustfintech/some-repo"], "include": [], "disabled": false }`.
  `exclude` beats `include`. `disabled: true` and the env var `TEAM_MEM_OFF=1`
  are full kill switches.
- **Redaction runs client-side before spool or send** (§7). The on-disk spool is
  already redacted.
- **Visibility rule (by design):** inside a registered project, everything
  captured is visible to the entire team. Queries work from anywhere; capture
  happens only inside registered projects.
- **Deletion:** a user can delete their own sessions (and cascaded events/
  observations/summaries) via `DELETE /api/sessions/:id`; the admin token can
  delete anything.
- Never captured: thinking blocks (not present in hook payloads), file contents
  except as capped tool-result excerpts, anything from skipped tools (§6),
  anything from `mcp__team-memory__*` tools (prevents echo loops).

## 6. Client plugin

Distribution: this repo is added once per machine as a plugin marketplace
(`claude plugin marketplace add <repo>`), then `claude plugin install team-mem`.
Per-user setup: export `TEAM_MEM_URL` and `TEAM_MEM_TOKEN` in the shell profile.
Hooks and the plugin's `.mcp.json` both read those env vars (`.mcp.json` via
`${TEAM_MEM_URL:-http://localhost:7337}` expansion). `~/.team-mem/config.json`
holds only non-secret preferences (§5).

Hooks (all: if not in a registered project or killed by switch, exit 0 silently):

| Hook | Behavior |
| --- | --- |
| `SessionStart` (matcher `startup\|clear\|compact`) | Synchronous, 5 s timeout: GET `/context`, emit `additionalContext` with the briefing; then spawn detached spool flush. On any failure: no output, exit 0. |
| `UserPromptSubmit` | Spawn detached sender with `{kind:"prompt"}` event; exit immediately. |
| `PostToolUse` (matcher `*`) | Skip-list check (below), then detached sender with `{kind:"tool"}` event. |
| `Stop` | Detached sender with `{kind:"end"}` event. |

Skipped tools: `TodoWrite`, `AskUserQuestion`, `Skill`, `SlashCommand`,
`ExitPlanMode`, `ListMcpResourcesTool`, `ToolSearch`, and every
`mcp__team-memory__*` tool.

**Detached sender** (`scripts/send.js`, zero-dep Node): builds the event
(redacted + capped per §7), claims the spool by atomic rename
(`spool.jsonl` → `spool.sending.<pid>.jsonl`), POSTs `{events:[...current +
claimed...]}` to `/ingest` with a 3 s timeout. On success, deletes the claimed
file; on failure, appends everything (current event included) back to
`spool.jsonl`. Spool cap 5 MB — oldest lines dropped first. Concurrent senders
are safe: each claims its own renamed file.

**Event shapes** (client → server):

```jsonc
{ "kind": "prompt", "session": "<uuid>", "repo": "mustfintech/web",
  "branch": "main", "ts": 1724800000000, "text": "<capped 4000 chars>" }
{ "kind": "tool", ... , "tool": "Edit",
  "input": "<capped 500 chars>", "result": "<capped 1500 chars: head 1000 + tail 500>" }
{ "kind": "end", ... }
```

## 7. Redaction and caps (client-side)

Applied to prompt text, tool input, and tool result before anything is written
or sent. Replacement token: `[REDACTED]`.

- AWS access key ids (`AKIA[0-9A-Z]{16}`) and `aws_secret…=` values
- JWTs (`eyJ…\.eyJ…\.…`)
- PEM blocks (`-----BEGIN … KEY-----` … `-----END`)
- Value part of `(?i)(password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+`
- Unbroken base64/hex runs ≥ 40 chars
- Entire result when the tool read a file whose name matches `.env*`

Caps: prompt ≤ 4000 chars; tool input ≤ 500; tool result ≤ 1500 (head 1000 +
tail 500 with `…[snip]…` marker); one POST body ≤ 64 KB (batch), single event
≤ 8 KB. Redaction is best-effort defense in depth — the transport is
VPN-internal and the audience is the team itself.

## 8. Server

Single Bun process. Config via `server/.env`: `PORT` (default **7337**),
`DB_PATH`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_MAX_CONCURRENT`
(default 1 — the LLM is shared with l2u-work), `ADMIN_TOKEN`.

**Ingest** (`POST /ingest`): auth by bearer token → user; validate each event
(size, kind, repo matches a registrable pattern); stamp `user_id`; upsert
`projects` row (workspace from `workspaces.json`, else workspace = repo name);
upsert `sessions` row (`last_event_at` = now; first event sets `user_id`,
`branch`, `started_at`); events whose `session` already belongs to a different
user are rejected. Insert raw rows, return 200. No LLM in this path.

**`workspaces.json`**: `{ "l2u": ["mustfintech/l2u-sandbox", "mustfintech/web",
"mustfintech/app", "mustfintech/l2u-2nd"] }` — exact repo list to be confirmed
with the team at deploy time (external prerequisite E4, §15; fallback rule
covers unlisted repos).

**Compression worker**: polls every 15 s for (a) sessions with ≥ 20 uncompressed
events, (b) sessions with an `end` event or `last_event_at` > 30 min ago — the
abandoned-session sweep, which sets `ended_at` and then treats the session
exactly like an ended one (summary included). For each batch: one LLM call
distills events into
**observations** `{type: decision|change|discovery|bug|how-it-works, title,
body, files[], tags[]}`; marks events compressed. At session end: second call
writes a **session summary** `{body, open_threads}` from that session's
observations + last events. Output is requested as JSON, validated, one retry;
after 3 failed attempts events are parked (`compressed = -1`, raw kept) and the
worker moves on. Restart-safe because the queue *is* the events table.

**LLM provider**: one interface, OpenAI-compatible `POST {base}/chat/completions`.
Default = local glm-5.2 endpoint; an Anthropic key via Anthropic's
OpenAI-compat endpoint is a config swap (quality fallback, decision D1 §15).

**Schema** (SQLite, WAL mode; timestamps = UTC ms):

```sql
users(id, name, role, token_hash, created_at)         -- role: member|service|admin
projects(id, repo_key UNIQUE, workspace, created_at)
sessions(id TEXT PK, user_id, project_id, branch, started_at, last_event_at, ended_at)
events(id, session_id, user_id, project_id, ts, kind, payload, compressed DEFAULT 0)
  -- events.ts = server receive time (authoritative); the client's own ts stays in payload
observations(id, session_id, user_id, project_id, ts, type, title, body, files, tags)
summaries(id, session_id UNIQUE, user_id, project_id, ts, body, open_threads)
-- + FTS5 external-content tables over observations(title, body, tags)
--   and summaries(body, open_threads)
```

**Retention**: compressed events pruned after 7 days; parked events after 30;
sessions with no observations pruned after 30 days. Observations and summaries
are kept indefinitely (they are small).

## 9. Retrieval

**Briefing** — `GET /context?repo=&branch=` (user from token), plain text ≤
6000 chars (~1.5 K tokens):

1. *Your last session here* — the caller's most recent summary in this repo.
2. *Team activity* — workspace-wide, last 72 h, newest first, up to 10 items,
   caller's own excluded: session summaries preferred, plus `decision`/`bug`
   observations; each item ≤ 2 lines with user, repo, relative time ("2 h ago" —
   relative everywhere, since the team spans KST and other timezones).
3. Footer pointing at the MCP tools for anything deeper.

**MCP** — official TypeScript MCP SDK, Streamable HTTP transport mounted at
`/mcp`, same bearer auth. Tools follow claude-mem's token-efficient layering
(compact index → chronology → full fetch):

| Tool | Input | Returns |
| --- | --- | --- |
| `team_status` | `{workspace?, days=3}` | Per-user digest incl. live sessions ("Haseeb: active now in l2u-sandbox/main, last event 4 m ago") |
| `team_search` | `{query, workspace?, user?, type?, limit=10}` | Compact rows: id, relative time, user, repo, type, title |
| `team_timeline` | `{anchor_id? \| session_id?, before=5, after=5}` | Chronological titles around the anchor |
| `team_get` | `{ids[] (≤10)}` | Full observation/summary bodies |

**REST mirror** for l2u-work (read endpoints + deletion): `GET /api/status`,
`GET /api/search`, `GET /api/sessions/:id`, `DELETE /api/sessions/:id`
(own-only unless admin). l2u-work gets a `service`-role token: read-only, no
delete, and it calls `localhost:7337` on the same machine.

## 10. Auth & transport

- Per-user bearer tokens (`tm_<32 random chars>`), generated by an admin CLI
  (`bun run admin user add|list|revoke`); server stores SHA-256 of the token;
  plaintext shown once at creation.
- Roles: `member` (ingest + query + delete own), `service` (query only),
  `admin` (everything).
- Transport is plain HTTP bound to the VPN-reachable interface; WireGuard
  already encrypts the path. If the server is ever exposed beyond the VPN, TLS
  (Caddy in front) is added before anything else changes.
- The existing `team-memory` MCP entry pointing at `http://localhost:3000/mcp`
  gets repointed to `http://<mac-studio-vpn-addr>:7337/mcp` (or removed in
  favor of the plugin's entry).

## 11. Failure handling

| Failure | Behavior |
| --- | --- |
| VPN off / server unreachable | Send-hooks spool locally (5 MB cap); SessionStart yields no briefing; next successful contact flushes |
| Server process crash | launchd restarts it; SQLite WAL keeps integrity; clients spool meanwhile |
| LLM down/overloaded | Raw events accumulate; worker retries; briefings serve existing data |
| Malformed LLM output | Validate + 1 retry; after 3 attempts park events, keep raw |
| Spool overflow | Drop oldest lines; memory has a gap, Claude Code unaffected |
| Clock skew between machines | Server stamps receive time; client `ts` is informational |

## 12. Testing

- **Unit (client):** remote normalization + allowlist matching (aliases, HTTPS,
  no-git), redaction patterns, caps, spool claim/flush/cap logic.
- **Unit (server):** token auth + roles, workspace mapping, retention pruning,
  briefing composition budget.
- **Integration:** server with a **fake LLM provider** (canned JSON): ingest →
  compression → observations/summaries → briefing + all four MCP tools + REST,
  asserted end to end; MCP contract via the SDK client.
- **E2E smoke script:** two fake users post realistic event streams; assert each
  side's briefing shows the other's work; runnable against a real glm-5.2
  endpoint before deploy.
- TDD throughout (superpowers workflow).

## 13. Deployment & ops

- launchd plist (`KeepAlive`, `RunAtLoad`) under a service account on the Mac
  Studio; logs to files; DB at `~/.team-mem-server/data.db`.
- Nightly `sqlite3 .backup` to `~/.team-mem-server/backups/`, keep 14.
- Setup asks to Hoyoung (external prerequisites, §15): VPN-reachable address
  for the Mac Studio, one open port (7337), glm-5.2 endpoint URL, and the run
  location for the server process.

## 14. v2 doors (designed-for, not built)

- **Live agent-to-agent questions:** `sessions.last_event_at` already tracks
  liveness; an inbox table + delivery through existing hook round-trips
  (SessionStart/UserPromptSubmit `additionalContext`) bolts on without
  restructuring.
- **Scrum-board/task sync:** own design cycle; would live beside memory in the
  same server.
- **Semantic search:** embeddings column + local embedding model behind the
  same provider interface.
- **Web activity feed:** single read-only server-rendered page; cut from v1.

## 15. External prerequisites & flagged decisions

| # | Item | Owner | Default until resolved |
| --- | --- | --- | --- |
| E1 | Mac Studio VPN address + port 7337 reachable | Hoyoung | develop against localhost |
| E2 | glm-5.2 OpenAI-compatible endpoint URL + capacity to share | Hoyoung | fake provider in tests; `LLM_MAX_CONCURRENT=1` |
| E3 | Node ≥ 18 on all teammate machines | each teammate | assumed true (JS team) |
| E4 | Confirm repo list for workspace `l2u` | team | fallback rule: any `mustfintech/*` repo = its own workspace |
| D1 | If glm-5.2 extraction quality is poor | team | swap `LLM_*` config to a hosted model (Anthropic OpenAI-compat endpoint); no code change |
