# l2u-bot Design (Phase 1)

Date: 2026-08-28
Status: Approved (Phase 1 scope only)

## 1. Purpose

A bot invoked from the l2u-work Slack channels. It reads conversation context from
channels and threads, GitHub issues and pull requests, and the `mustfintech/l2u-sandbox`
codebase, then answers in the thread with judgements grounded in what it found.

Slack is the primary interface. The bot absorbs the time people spend gathering and
organizing context.

## 2. Scope

### In scope for Phase 1
- Slack reads: mentions, full threads, channel history, reactions, user profiles
- GitHub reads: issue lists and details, PR metadata and diffs
- Codebase reads: search and file reads over a local clone
- Tool-calling loop over the LiteLLM gateway for synthesis
- Posting the answer to the Slack thread

### Out of scope for Phase 1 (deferred)
- Creating GitHub issues — deferred by the user
- Posting PR review comments, closing or labeling issues, any GitHub write
- Code changes, commits, pull requests
- Sending anything outside Slack

**This boundary is the central safety property.** No write tool is registered, so even a
successful prompt injection has no external write action available to it.

## 3. Decisions and rationale

| Decision | Choice | Rationale |
|---|---|---|
| Agent architecture | Custom loop over LiteLLM | Full control over tool permissions, cost, and logging. Tool calling verified working |
| Runtime | Local Mac, always on, Socket Mode | No public URL needed. Reuses the local clone, `gh` session, and `LITELLM_KEY` |
| Write approval | Not applicable (read-only) | Write capability is excluded from Phase 1 entirely |
| Language / runtime | TypeScript + `@slack/bolt` | First-class Socket Mode support. Same language as l2u-sandbox |
| LLM client | `openai` SDK with a replaced baseURL | The LiteLLM gateway is OpenAI-compatible; no dedicated client needed |

### 3.1 Verified facts (measured 2026-08-28)

**LiteLLM tool calling** — `POST /v1/chat/completions` with `tools` and `tool_choice: auto`:

| Model | Result |
|---|---|
| `glm-5.2` | `finish_reason: tool_calls`, working |
| `kimi-k2.7-code:cloud` | `finish_reason: tool_calls`, working |
| `gemini/gemini-3.5-flash` | `finish_reason: tool_calls`, working |
| `gemini/gemini-3.1-pro-preview` | `finish_reason: tool_calls`, working |
| `gemma4` | `finish_reason: tool_calls`, working |
| `grok-4.5` | Monthly usage limit reached (resets in ~10 days) |
| `kimi-k3` | Monthly usage limit reached (resets in ~10 days) |

**Current model roster** (measured via `GET /v1/models`) — the `gemini-2.5-*` models named
in the `litellm-delegate` skill documentation do not exist:

```
gemini/gemini-3.1-pro-preview, gemini/gemini-3.5-flash, gemini/gemini-3.5-flash-lite,
gemini/gemini-3.6-flash, gemini/gemini-3.7-flash, gemma4, glm-5.2,
grok-4.5, grok-4.5-go2, kimi-k2.7-code, kimi-k3, kimi-k3-go2, translategemma
```

**Gemini `thought_signature`** — Gemini models return
`tool_calls[].provider_specific_fields.thought_signature`. In a multi-turn tool loop the
assistant message must go back into the history **as the original object**; reconstructing
it drops the signature and breaks reasoning continuity.

**Slack rate limits** — the 2025-05-29 tightening of `conversations.history` and
`conversations.replies` (1 request/minute, 15 messages) applies to **apps distributed
outside the Slack Marketplace**. Internal customer-built apps are unaffected. On-demand
history reads are therefore viable and a local message store is unnecessary.

> **Constraint**: turning this into a distributed app triggers those limits and
> invalidates the design. It must stay an internal single-workspace app.

## 4. Architecture

```
Slack Workspace
   │  (WebSocket / Socket Mode)
   ▼
slack/gateway ──► dedupe(event_id) ──► in-memory job queue
   │                                        │
   │ immediate ack                          ▼
   │                                   worker (serial)
   │                                        │
   │                          ┌─────────────┼─────────────┐
   │                          ▼             ▼             ▼
   │                   slack/collector  agent/loop    audit/log
   │                                        │
   │                                   agent/tools
   │                          ┌─────────────┼─────────────┐
   │                          ▼             ▼             ▼
   │                    slack/collector github/reader repo/search
   ▼
slack/responder  ──►  placeholder → progress updates → final answer
```

A single Node process. The queue is in memory, which suits Phase 1 concurrency.
In-flight work is lost on restart, and that is accepted.

## 5. Module specifications

Each module targets 200–400 lines and must not exceed 800.

### 5.1 `slack/gateway`
- Responsibility: Socket Mode connection, event subscription, deduplication, queueing
- Subscribed events (Phase 1): `app_mention`, `message.im`
- The channel allowlist is applied here; events from other channels are dropped, not queued
- Deduplication: `event_id` held in a Set with a 10-minute TTL
- Interface: `start(onJob: (job: Job) => void): Promise<void>`

### 5.2 `slack/collector`
- Responsibility: collect and normalize raw Slack data
- `readThread`, `readChannel`, `readReactions`, `userInfo`
- Normalization: `<@U123>` mentions to display names, timestamps to KST ISO, bot messages marked
- `readReactions` falls back to a history lookup when the `reactions:read` scope is absent

### 5.3 `slack/responder`
- Responsibility: post, update, and deliver the answer
- Flow: `chat.postMessage` placeholder → throttled progress updates → `chat.update` with the answer
- Splits on line boundaries and hard-splits oversized lines; retries smaller on `msg_too_long`
- Failures are reported in the thread. The bot never goes silent

### 5.4 `agent/loop`
- Responsibility: the LiteLLM tool-calling loop
- Algorithm:
  1. System prompt plus the normalized Slack context wrapped in the trust boundary
  2. Call `chat.completions` with `tools` and `tool_choice: auto`
  3. On `finish_reason === 'tool_calls'`, run each tool, append `role: tool` results, repeat
  4. On `finish_reason === 'stop'`, return the text
- Limits: 20 turns maximum; stops and concludes when the token budget or deadline is hit
- Assistant messages are stored **unmodified** to preserve `thought_signature`
- Model fallback walks the chain on 429, quota, and 5xx errors

### 5.5 `agent/tools`
- Responsibility: tool JSON schemas and execution dispatch
- **Only read-only tools are registered.** Write tools do not exist in the code
- Results are capped (20KB default); truncation is stated in the content
- Execution failures return `{ error }` to the loop rather than throwing

### 5.6 `github/reader`
- Responsibility: read-only `gh` CLI wrapper
- Target repository fixed in configuration; the model cannot specify one
- Allowed: `gh issue list`, `gh issue view`, `gh pr list`, `gh pr view`, `gh pr diff`
- Arguments passed as arrays, never interpolated into a shell string

### 5.7 `repo/search`
- Responsibility: local clone search and file reads
- **Path sandbox**: input resolved and checked against the clone root, re-checked after `realpath`
- The clone is never auto-updated. The answer footer carries the commit SHA and branch so a
  human can tell whether the reasoning ran against stale code

### 5.8 `audit/log`
- Responsibility: audit trail of every request
- Records time, requester, channel, original text, model, every tool call with arguments,
  the final answer, duration, and stop reason, as JSONL rotated by date

## 6. Tool catalog (Phase 1, all read-only)

| Tool | Arguments | Description |
|---|---|---|
| `slack_read_thread` | `channel`, `thread_ts` | Full thread |
| `slack_read_channel` | `channel`, `limit` | Recent channel messages |
| `slack_read_reactions` | `channel`, `ts` | Reactions on a message |
| `slack_user_info` | `user_id` | Display name and title |
| `gh_list_issues` | `state?`, `labels?`, `limit?` | Issue list |
| `gh_search_issues` | `query`, `limit?` | Issue search |
| `gh_get_issue` | `number` | Issue body and comments |
| `gh_list_prs` | `state?`, `limit?` | PR list |
| `gh_get_pr` | `number` | PR metadata, comments, reviews |
| `gh_get_pr_diff` | `number` | PR diff |
| `repo_grep` | `pattern`, `path?`, `glob?` | Code search |
| `repo_read_file` | `path`, `start?`, `end?` | File read |
| `repo_list_files` | `path` | Directory listing |

## 7. Data flow

1. A user mentions the bot in a channel
2. `slack/gateway` receives the event and Bolt acks immediately
3. Duplicate `event_id` is dropped; otherwise the job is queued
4. The worker posts a placeholder
5. `slack/collector` gathers baseline context (thread, reactions, requester)
6. `agent/loop` runs; the model requests further Slack, GitHub, or code lookups itself
7. Progress notes replace the placeholder as turns advance, throttled to 5 seconds
8. The final text overwrites the placeholder
9. `audit/log` records the whole exchange

## 8. Model routing and context budget

### Routing
- Primary chain: `glm-5.2` → `gemma4` → `gemini/gemini-3.5-flash`
- Compaction and classification: `gemini/gemini-3.5-flash-lite`
- Excluded: `grok-4.5`, `kimi-k3` (monthly quota exhausted)

### Budget
- Per-result cap of 20KB, with truncation stated in the result
- Context limits tracked per model. Above 60% of the limit, older tool results are
  summarized by the compact model and replaced
- Large inputs such as PR diffs are read per file rather than whole

## 9. Security

- **Trust boundary**: all Slack text is wrapped in `<untrusted_slack_content>`, and the
  system prompt states that instructions inside it are data, not commands
- **Minimal tool surface**: with only read tools, the worst outcome of an injection is a
  wrong answer
- **Path sandbox**: `repo_read_file` and `repo_grep` reject anything outside the clone root
- **Fixed repository**: GitHub lookups target a configured repository only
- **No shell**: every external command runs with an argument array
- **Channel allowlist**: the bot responds only in configured channels
- **Secrets**: injected via `.env` only, never committed, never logged

## 10. Error handling

| Situation | Handling |
|---|---|
| Slack event redelivery | Dropped by `event_id` deduplication |
| Tool failure | Returned to the loop as `{ error }` for the model to work around |
| LiteLLM 429 / quota | Fall back through the chain; report the reason in-thread if all fail |
| Turn limit reached | Answer with findings so far, marked as incomplete |
| Job timeout (5 min default) | Stop the loop and update the placeholder with a timeout notice |
| Slack 429 | Back off honoring `Retry-After` |
| `msg_too_long` | Retry delivery with smaller chunks |
| Process crash | In-flight work is lost; a posted placeholder is left as-is, no recovery attempted |

## 11. Testing strategy

Test-driven: write the test, watch it fail, then implement.

- **Unit**: normalization, path sandbox (including `..` and symlink escapes), result
  truncation, deduplication, configuration validation, message splitting
- **Integration**: Slack event fixtures through to a response with mocked LiteLLM output;
  `thought_signature` preservation across turns; model fallback on 429
- **Smoke**: a real mention in one designated test channel
- Coverage target: 80% or above

## 12. Configuration and secrets

`.env`:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...      # App-level token for Socket Mode (connections:write)
LITELLM_KEY=sk-...
LITELLM_BASE_URL=https://litellm.must.codes
LITELLM_MODEL_CHAIN=glm-5.2,gemma4,gemini/gemini-3.5-flash
GITHUB_REPO=mustfintech/l2u-sandbox
REPO_CLONE_PATH=/path/to/clone
```

GitHub authentication reuses the local `gh` CLI session; no separate token is issued.

## 13. Pre-flight checklist

Confirm in the Slack app configuration before running:

1. **Socket Mode** enabled and an app-level token (`xapp-`, `connections:write`) issued
2. **Bot Token Scopes**: `app_mentions:read`, `channels:history`, `groups:history`,
   `chat:write`, `reactions:read`, `users:read`, `im:history`
3. **Event Subscriptions**: `app_mention`, `message.im`
4. Bot invited to the target channels
5. Local clone path for `l2u-sandbox` confirmed

## 13.1 Changes made during implementation (2026-08-28)

Implementation surfaced facts that changed the design.

**Code search falls back to `git grep`**
- No ripgrep binary exists in this environment. `rg` is only a shell function shim, and the
  bot runs commands without a shell, so it failed with `spawn rg ENOENT`.
- A real binary is used when found via `RIPGREP_PATH` or known paths; otherwise `git grep`.
- `git grep` searches tracked files only, so `node_modules` is excluded for free.

**Search split into two stages**
- A single common word such as `SUT` produced 9.3MB of output, exceeding the 8MB
  `maxBuffer` and failing.
- Stage one lists matching files with `git grep -l`. Above 40 files, only the file list is
  returned.
- Stage two reads lines from that narrowed set, capped at 4 lines per file and 300
  characters per line.
- Result: the same search went from a 9.3MB failure to 3.7KB in 166ms.

**Repository overview injected into the system prompt**
- Without it the model spent early turns searching for `*.go` files that do not exist here.
- `git ls-files` is aggregated into top-level directory and extension distributions.

**Turn limit raised from 12 to 20**
- At 12, codebase investigations repeatedly ran out before reaching a conclusion.

**Investigation strategy added to the system prompt**
- Search locates; once a candidate is found, read the file. Do not repeat searches against
  the same target.

**A Slack-free CLI (`pnpm ask`) added**
- Same model chain, prompt, and tools as the bot, minus Slack lookups.
- Runs without Slack tokens, making it the regression check for investigation quality.

**Response length handling**
- A real run failed with `msg_too_long`. The cause was that line-boundary splitting leaves
  a single newline-free paragraph intact, and such a paragraph can exceed Slack's limit
  on its own.
- Oversized lines are now hard-split at a word boundary, delivery retries with smaller
  chunks on `msg_too_long`, and the system prompt carries an explicit length budget.

**Progress updates**
- Investigations run tens of seconds. The placeholder is updated with the current turn and
  tools in use, throttled to one update per 5 seconds to respect Slack rate limits.

**Response language rule**
- English by default; Korean when the requester writes in Korean. Technical terms and code
  identifiers stay in their original form.

**`gh_search_issues` added to the tool catalog**

## 14. Future phases (outside Phase 1)

- **Phase 2**: introducing GitHub writes requires a two-step gate — draft, Slack button
  approval, then execution — plus an approver allowlist wired into the audit log.
- **Phase 3**: move to a server or container for continuous operation, replacing the
  in-memory queue with durable storage.

## 15. Open questions

- Whether to trigger on a specific emoji reaction (`reaction_added`) in addition to
  mentions. Phase 1 starts with mentions and DMs; the emoji trigger is decided after use.
- Response length policy (summary-first versus detail-first) is tuned after initial use.
