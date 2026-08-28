# team-mem — Setup Guide

How to stand up the team-mem server on the Mac Studio, install the plugin on
each teammate's machine, and what the team should know about privacy. See
also the [design spec](../../docs/superpowers/specs/2026-08-28-team-mem-design.md)
(§5 privacy, §13 deployment, §15 external prerequisites) and the
[implementation plan](../../docs/superpowers/plans/2026-08-28-team-mem.md).

Throughout, `<vpn-addr>` is the Mac Studio's Defguard VPN address (external
prerequisite E1, below) — substitute the real address once it's assigned.

## 1. Server (Hoyoung, Mac Studio — once)

1. Install Bun:

   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. Clone the repo and install dependencies:

   ```bash
   git clone git@github.com:must-desertsand/Team-MCP-Claude-Mem.git ~/Team-MCP-Claude-Mem
   cd ~/Team-MCP-Claude-Mem/server
   bun install
   ```

3. Create and edit the runtime config:

   ```bash
   cp .env.example .env
   ```

   In `.env`, set `LLM_BASE_URL` (and `LLM_MODEL` if it differs from the
   default `glm-5.2`) to the glm-5.2 OpenAI-compatible endpoint already
   serving l2u-work — external prerequisite **E2**. Leave
   `LLM_MAX_CONCURRENT=1` (shared capacity with l2u-work; do not raise it
   without checking with Hoyoung first). Bun auto-loads `server/.env` from
   the working directory — no extra flags needed to run the server.

4. Review `server/workspaces.json` with the team — confirm the repo list
   under each workspace is current (external prerequisite **E4**). Edit the
   file directly if repos need to be added or removed; no code change
   required.

5. Create a user for everyone who needs access. Each command prints a
   plaintext token **once** — copy it immediately and send it to that person
   privately (a DM, not a channel):

   ```bash
   bun run admin user add hoyoung --role admin
   bun run admin user add <teammate-name>          # repeat per teammate; default role is "member"
   bun run admin user add l2u-work --role service   # read-only, for the Slack bot
   ```

6. Install the launchd services. The shipped plists in `server/deploy/`
   assume the service account is `l2u`, the repo is cloned to
   `/Users/l2u/Team-MCP-Claude-Mem`, and Bun is at `/Users/l2u/.bun/bin/bun`
   (the default install location). If any of that differs on the Mac
   Studio, edit the `<string>` paths in both `.plist` files first.

   The commands below assume you're still in `~/Team-MCP-Claude-Mem/server`
   from step 2 (the plists are at `deploy/`, relative to that):

   ```bash
   mkdir -p ~/Library/LaunchAgents
   cp deploy/com.must.team-mem.plist deploy/com.must.team-mem.backup.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.must.team-mem.plist
   launchctl load ~/Library/LaunchAgents/com.must.team-mem.backup.plist
   ```

   Confirm both are loaded:

   ```bash
   launchctl list | grep com.must.team-mem
   ```

   `com.must.team-mem` runs the server (`RunAtLoad` + `KeepAlive`, so it
   starts now and restarts on crash/reboot); `com.must.team-mem.backup` runs
   `backup.sh` once daily at 03:30 via `StartCalendarInterval`. Logs land in
   `~/.team-mem-server/logs/`.

7. Make port 7337 reachable to teammates over the Defguard VPN (**E1**) —
   this is a VPN/firewall configuration step outside this repo. Once done,
   verify from a teammate's machine:

   ```bash
   curl http://<vpn-addr>:7337/health
   ```

   Expect `{"ok":true}`. This endpoint takes no auth token, so a plain
   `curl` is enough to confirm reachability.

## 2. Each teammate (once per machine)

1. Check Node is 18 or newer (external prerequisite **E3**):

   ```bash
   node --version
   ```

2. Install the plugin:

   ```bash
   claude plugin marketplace add must-desertsand/Team-MCP-Claude-Mem
   claude plugin install team-mem@must-desertsand
   ```

3. Add your credentials to your shell profile (`~/.zshrc` or `~/.bashrc`),
   then open a new terminal (or `source` the file):

   ```bash
   export TEAM_MEM_URL=http://<vpn-addr>:7337
   export TEAM_MEM_TOKEN=tm_...   # the token Hoyoung sent you — keep it secret
   ```

4. If you have an old `team-memory` MCP entry pointing at `localhost:3000`
   from a previous setup, remove it — the plugin ships its own `team-memory`
   MCP server pointed at `$TEAM_MEM_URL`:

   ```bash
   claude mcp list             # check whether one exists
   claude mcp remove team-memory
   ```

5. Verify: work for a few minutes in any team repo (`mustfintech/*` or
   `must-desertsand/*`), then confirm the server saw you:

   ```bash
   curl -H "Authorization: Bearer $TEAM_MEM_TOKEN" "$TEAM_MEM_URL/api/status"
   ```

   Your name should appear in the returned list. The next Claude Code
   session you start in that repo (a fresh `startup`, `clear`, or `compact`)
   should open with a `[team-mem] Team memory briefing:` block in context.

## 3. Privacy notes for the team

- **Capture is allowlist-only and client-enforced.** Only repos under
  `mustfintech/*` and `must-desertsand/*` (the default allowlist) are ever
  recorded. Anything else — personal projects, other work, non-git
  directories — produces **zero network traffic**: the hook exits before
  touching the network. See spec §5 for the full capture-boundary rules.
- **Inside a registered project, everything captured is visible to the
  whole team** — that is the product. This includes prompts, capped/redacted
  tool activity, and per-session summaries.
- **Never captured:** thinking blocks, full file contents (only capped
  tool-result excerpts), skipped tools (`TodoWrite`, `AskUserQuestion`,
  `Skill`, `SlashCommand`, `ExitPlanMode`, `ListMcpResourcesTool`,
  `ToolSearch`, and any `mcp__team-memory__*` tool), or anything from a
  repo outside the allowlist.
- **Secrets are redacted client-side** before anything is written to the
  local spool or sent: AWS keys, JWTs, PEM blocks, `password`/`token`/
  `api-key`-shaped values, long base64/hex runs, and the entire result of
  reading any `.env*` file.
- **Kill switches:**
  - `TEAM_MEM_OFF=1` in your shell environment disables capture entirely.
  - `~/.team-mem/config.json` — set `{"disabled": true}` for the same
    effect, or narrow capture with `"exclude": ["mustfintech/some-repo"]`
    (exclude always beats include) / `"include": [...]`.
- **Delete your own sessions** any time (cascades to that session's events,
  observations, and summary):

  ```bash
  curl -X DELETE -H "Authorization: Bearer $TEAM_MEM_TOKEN" "$TEAM_MEM_URL/api/sessions/<session-id>"
  ```

  An admin token can delete any session.

## 4. l2u-work integration (Hoyoung)

The Slack bot queries team-mem with the `service`-role token created in
step 1 (`l2u-work` — query only; it cannot ingest or delete). Since the bot
runs on the Mac Studio itself, it can call the server on localhost:

```bash
curl -H "Authorization: Bearer $L2U_WORK_TOKEN" "http://127.0.0.1:7337/api/status"
curl -H "Authorization: Bearer $L2U_WORK_TOKEN" "http://127.0.0.1:7337/api/search?q=<term>"
```

`/api/status` optionally takes `workspace` and `days` query params;
`/api/search` optionally takes `workspace`, `user`, `type`, and `limit` —
see `server/src/rest.ts` for the full parameter list.
