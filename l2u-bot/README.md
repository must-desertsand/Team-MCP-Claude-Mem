# l2u-bot

A read-only assistant agent for the l2u-work Slack workspace.
It reads Slack conversation context, GitHub issues and pull requests, and the
`mustfintech/l2u-sandbox` codebase, then answers in the thread with evidence-backed findings.

The model runs as a tool-calling loop against the internal LiteLLM gateway (`litellm.must.codes`).

## Current state (Phase 1)

**Read-only.** There are no tools for creating GitHub issues, posting PR comments, or
changing code. Because no write tool exists, a successful prompt injection through Slack
has no external action available to it.

Design document: `docs/superpowers/specs/2026-08-28-l2u-slack-bot-design.md`

## Setup

```bash
pnpm install
cp .env.example .env   # fill in the values
```

### Required values

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-` Bot User OAuth Token (Slack app → OAuth & Permissions) |
| `SLACK_APP_TOKEN` | `xapp-` App-Level Token with `connections:write` (for Socket Mode) |
| `SLACK_ALLOWED_CHANNELS` | Comma-separated channel IDs. Empty means every channel |
| `LITELLM_KEY` | LiteLLM gateway API key |
| `LITELLM_MODEL_CHAIN` | Primary model chain, tried in order on failure |
| `AUDIT_RETENTION_DAYS` | Days to keep audit logs, pruned at startup and daily. `0` disables |
| `GITHUB_REPO` | Target repository. The model cannot change it |
| `REPO_CLONE_PATH` | Local clone used for code search |

### Slack app configuration

1. Enable **Socket Mode** and issue an App-Level Token with `connections:write`
2. **Bot Token Scopes**: `app_mentions:read`, `channels:history`, `groups:history`,
   `chat:write`, `reactions:read`, `users:read`, `im:history`
3. **Event Subscriptions**: `app_mention`, `message.im`
4. Invite the bot to the target channels

> Keep this app internal to the workspace. Distributing it outside the Slack Marketplace
> drops `conversations.history/replies` to one request per minute and 15 messages, which
> invalidates a core assumption of this design.

### External tools

- `git` — used for code search (`git grep`)
- `gh` — GitHub lookups, reusing the local CLI session (check with `gh auth status`)
- `rg` (optional) — used when present. It must be a real binary; shell functions and
  aliases do not work because commands run without a shell. Set `RIPGREP_PATH` to point
  at one directly. Without it, `git grep` is used.

## Running

```bash
pnpm start        # start the bot (Socket Mode)
pnpm dev          # restart on file changes
```

Check the agent without Slack:

```bash
pnpm ask "Where is Toss payment cancellation handled?"
```

`ask` uses the same model chain, prompt, and tools as the bot, minus the Slack lookup
tools. It needs no Slack token, so it is the fastest way to check investigation quality.

## Preflight

```bash
pnpm doctor
```

Checks everything the bot depends on and reports what is missing with the fix for each:
runtimes, `gh` authentication and repo access, the code clone's branch and cleanliness,
Slack token validity and granted scopes, LiteLLM reachability and whether the configured
models still exist on the gateway, audit directory permissions, whether an instance is
already running, and system sleep settings.

Run it first on any new machine. It turns "what does that host have?" into a measurement
instead of a guess. Exit code is non-zero when something is actually broken; warnings do
not block startup.

## Deploying to a shared always-on host

**Run exactly one instance.** Slack routes each Socket Mode event to exactly one
connection, so a second instance does not duplicate replies — it silently takes half the
traffic and answers from whatever clone that machine has. A lock file
(`.l2u-bot.lock`) blocks a second start on the same machine; a second host cannot be
detected from here and remains an operational rule. `pnpm doctor` reports the lock holder.

Before moving:

1. Stop the instance on the old machine
2. `pnpm doctor` on the new host and resolve every failure
3. Use a **dedicated clone pinned to `main`**, not somebody's working copy — the bot
   answers from the working tree it is pointed at, uncommitted changes included
4. Authenticate `gh` via `GH_TOKEN`, not `gh auth login` — launchd jobs cannot reach the
   login keychain. Prefer a bot account or GitHub App token over a personal one
5. `chmod 700` the audit directory. It holds verbatim Slack conversations
6. Disable sleep: `sudo pmset -a sleep 0 disksleep 0`. Sleeping drops the WebSocket

Then install the launchd job:

```bash
export GH_TOKEN=...            # so GitHub lookups survive unattended
./deploy/install.sh            # or --print to inspect the plist first
```

It restarts on crash (`KeepAlive`), starts at load, throttles restart attempts, and writes
to `logs/`. Stop it with `launchctl bootout gui/$(id -u)/com.must.l2u-bot`.

A LaunchAgent needs a login session. For a host that must come back after a reboot with
nobody logged in, either enable automatic login or install the same plist as a
LaunchDaemon in `/Library/LaunchDaemons` — in which case `GH_TOKEN` is mandatory.

## Verification

```bash
pnpm test         # unit and integration tests
pnpm coverage     # coverage report
pnpm typecheck    # type checking
```

## Layout

| Module | Responsibility |
|---|---|
| `src/slack/gateway.ts` | Socket Mode connection, event intake, channel allowlist, deduplication |
| `src/slack/collector.ts` | Thread, channel, reaction, and user collection and normalization |
| `src/slack/normalize.ts` | Slack markup expansion, trust-boundary rendering |
| `src/slack/responder.ts` | Placeholder posting, progress updates, chunked delivery |
| `src/agent/loop.ts` | Tool-calling loop, model fallback, context compaction |
| `src/agent/tools.ts` | Tool schemas and dispatch (read-only) |
| `src/agent/prompt.ts` | System prompt |
| `src/github/reader.ts` | Read-only `gh` CLI wrapper |
| `src/repo/search.ts` | Local clone search and file reads |
| `src/repo/sandbox.ts` | Path sandbox |
| `src/audit/log.ts` | Full request log as JSONL (`audit/`), pruned by retention |
| `src/lock.ts` | Single-instance lock |
| `src/preflight/` | Preflight check evaluation |

## How it works

1. Mention arrives → Bolt acks immediately → job is queued (dropped if `event_id` repeats)
2. A "Looking into it…" placeholder is posted
3. Thread transcript plus repository state and overview are collected
4. The agent loop runs; the model calls whatever tools it needs
5. Progress notes replace the placeholder as turns advance (throttled to 5s)
6. The final answer replaces the placeholder, footed with the model, turn count, and commit

Jobs are processed serially. Running them concurrently spikes rate limits and cost together.

## Response handling

Slack rejects oversized messages with `msg_too_long`, and long answers are unreadable
regardless. Three things guard against it:

- The prompt sets a length budget and asks for short lines over long paragraphs.
- `splitForSlack` chunks on line boundaries and hard-splits any single line that exceeds
  the limit — a paragraph with no newlines was the actual cause of a delivery failure.
- On `msg_too_long`, delivery retries with a smaller chunk size rather than dropping the
  answer.

## Response language

The bot answers in English by default, and in Korean when the question is written in
Korean. Technical terms and code identifiers stay in their original form either way.

## Security boundaries

- Slack content is wrapped in `<untrusted_slack_content>` to separate data from
  instructions. Text imitating the boundary tag is neutralized.
- Code reads cannot leave the clone root. `..` escapes, absolute paths, symlink escapes,
  and `.git` / `node_modules` access are all rejected.
- External commands run with argument arrays only. No shell is involved, so command
  injection does not apply.
- The target repository is fixed in configuration and the model cannot change it.

## Team-Mem tools (added in this fork)

When `TEAM_MEM_BOT_TOKEN` is set in `.env`, the agent gains two read-only tools
backed by [Team-Mem](https://github.com/must-desertsand/Team-MCP-Claude-Mem)
(the team's shared Claude Code memory, expected on the same machine at
`http://127.0.0.1:7337`):

- `team_status` — who is working on what right now + recent session summaries
- `team_search` — full-text search over every teammate's recorded decisions,
  changes, bugs, and session summaries

The token is a `service`-role Team-Mem token (query-only; the server refuses
writes and deletes for it). Without the token, the bot behaves exactly as
before — the tools and their prompt section are omitted entirely.
