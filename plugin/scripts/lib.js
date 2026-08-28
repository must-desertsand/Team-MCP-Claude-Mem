"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), 2000);
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => { clearTimeout(timer); resolve(data); });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(data); });
  });
}

function teamMemDir(env = process.env) {
  return env.TEAM_MEM_DIR || path.join(os.homedir(), ".team-mem");
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function loadSettings(env = process.env) {
  const shipped = readJson(path.join(__dirname, "..", "allowlist.json")) || {};
  const local = readJson(path.join(teamMemDir(env), "config.json")) || {};
  const url = env.TEAM_MEM_URL || "";
  const token = env.TEAM_MEM_TOKEN || "";
  const include = [...(shipped.include || []), ...(local.include || [])];
  const exclude = [...(local.exclude || [])];
  const off = env.TEAM_MEM_OFF === "1" || local.disabled === true || !url || !token;
  return { url, token, off, include, exclude };
}

function normalizeRemote(url) {
  if (!url || typeof url !== "string") return null;
  let u = url.trim().replace(/\.git\/?$/i, "");
  if (!u) return null;
  if (u.includes("://")) {
    try {
      const parts = new URL(u).pathname.replace(/^\/+/, "").split("/");
      if (parts.length >= 2 && parts[0] && parts[1]) return `${parts[0]}/${parts[1]}`.toLowerCase();
    } catch {}
    return null;
  }
  const m = u.match(/^(?:[^@\s]+@)?[^:\s/]+:(.+)$/); // scp-like: [user@]host:path
  if (m) {
    const parts = m[1].split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`.toLowerCase();
  }
  return null;
}

function git(cwd, args) {
  try {
    return execSync(`git ${args}`, { cwd, timeout: 1500, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim() || null;
  } catch { return null; }
}
function repoKeyFor(cwd) { return normalizeRemote(git(cwd, "config --get remote.origin.url")); }
function gitBranch(cwd) { return git(cwd, "rev-parse --abbrev-ref HEAD"); }

function matchPattern(pattern, key) {
  const re = new RegExp(
    "^" + pattern.toLowerCase().split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+") + "$",
  );
  return re.test(key);
}

function isAllowed(repoKey, settings) {
  if (!repoKey) return false;
  const key = repoKey.toLowerCase();
  if ((settings.exclude || []).some(p => matchPattern(p, key))) return false;
  return (settings.include || []).some(p => matchPattern(p, key));
}

function redact(text) {
  if (!text) return text;
  let t = String(text);
  t = t.replace(/-----BEGIN [A-Z ]*KEY-----[\s\S]*?-----END [A-Z ]*KEY-----/g, "[REDACTED]");
  t = t.replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[REDACTED]");
  t = t.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]");
  t = t.replace(/(:\/\/[^\/\s:@"']+:)[^\/\s@"']+(@)/g, "$1[REDACTED]$2");
  t = t.replace(/\bbearer\s+[A-Za-z0-9._~+/-]{4,}=*/gi, "[REDACTED]");
  t = t.replace(/([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([^\s"']+)/gi, "$1[REDACTED]");
  t = t.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]");
  t = t.replace(/eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[REDACTED]");
  t = t.replace(/[A-Za-z0-9+]{40,}={0,2}/g, "[REDACTED]");
  return t;
}

function cap(s, max) {
  s = String(s ?? "");
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function capHeadTail(s, max = 1500, head = 1000, tail = 500) {
  s = String(s ?? "");
  if (s.length <= max) return s;
  return s.slice(0, head) + "\n…[snip]…\n" + s.slice(-tail);
}

const SKIP_TOOLS = new Set([
  "TodoWrite", "AskUserQuestion", "Skill", "SlashCommand", "ExitPlanMode", "ListMcpResourcesTool", "ToolSearch",
]);
function shouldSkipTool(name) {
  return !name || SKIP_TOOLS.has(name) || String(name).startsWith("mcp__team-memory__");
}

function stringifyVal(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
function isEnvRead(input) {
  const p = input && typeof input === "object" ? (input.file_path || input.path || "") : String(input || "");
  return /(^|\/)\.env[^/]*$/i.test(String(p));
}

function buildEvent(kind, hookInput, repoKey, branch) {
  const session = String(hookInput.session_id || "");
  if (session.length < 8) return null;
  const e = { kind, session, repo: repoKey, ts: Date.now() };
  if (branch) e.branch = String(branch).slice(0, 200);
  // Pre-cap at ~4x the target to bound regex cost (buildEvent runs synchronously in the hook
  // process), then redact, then apply the FINAL exact cap. redact() can grow text (e.g.
  // "token=1" -> "token=[REDACTED]"), so only the cap applied *after* redact is authoritative.
  if (kind === "prompt") e.text = cap(redact(cap(String(hookInput.prompt ?? ""), 16000)), 4000);
  if (kind === "tool") {
    if (shouldSkipTool(hookInput.tool_name)) return null;
    e.tool = String(hookInput.tool_name).slice(0, 200);
    e.input = cap(redact(cap(stringifyVal(hookInput.tool_input), 2000)), 500);
    e.result = isEnvRead(hookInput.tool_input)
      ? "[REDACTED .env file]"
      : capHeadTail(redact(capHeadTail(stringifyVal(hookInput.tool_response), 6000, 4000, 2000)), 1500, 1000, 500);
  }
  let json = JSON.stringify(e);
  if (json.length > 8192 && e.result) { e.result = cap(e.result, 500); json = JSON.stringify(e); }
  if (json.length > 8192) return null;
  return e;
}

const SPOOL_MAX_BYTES = 5 * 1024 * 1024;
function spoolDir(env = process.env) { return path.join(teamMemDir(env), "spool"); }

function writeSpoolEvent(event, env = process.env) {
  try {
    const dir = spoolDir(env);
    fs.mkdirSync(dir, { recursive: true });
    const name = `evt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify(event));
    pruneSpool(env);
  } catch {}
}

function pruneSpool(env = process.env) {
  try {
    const dir = spoolDir(env);
    // Same filter claimSpool uses for eligible names (`evt-*.json`, not `evt-*.json.claim-*`):
    // in-flight claimed files must never be eviction candidates, or a sender that's mid-send
    // during an offline-reconnect flood could have its claim silently deleted out from under
    // it, and releaseClaims/removeClaims would then no-op on a file that no longer exists.
    const files = fs.readdirSync(dir).filter(f => /^evt-.*\.json$/.test(f)).map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { f, size: st.size, mtime: st.mtimeMs };
    }).sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((s, x) => s + x.size, 0);
    for (const x of files) {
      if (total <= SPOOL_MAX_BYTES) break;
      try { fs.unlinkSync(path.join(dir, x.f)); total -= x.size; } catch {}
    }
  } catch {}
}

const STALE_CLAIM_MS = 10 * 60 * 1000;   // recover claims abandoned by a crashed/killed sender
const CLAIM_MAX_BYTES = 200_000;         // stay well under the server's 256KB ingest body cap

// A sender that's killed between claiming a file and removing/releasing it leaves a
// `.claim-<pid>` file that nothing will ever pick up again. Before listing claimable events,
// rename any claim file older than the threshold back to its base name so it rejoins the queue.
function recoverStaleClaims(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - STALE_CLAIM_MS;
  for (const f of entries) {
    if (!/\.claim-\d+$/.test(f)) continue;
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.renameSync(p, p.replace(/\.claim-\d+$/, ""));
    } catch {} // gone, raced, or already recovered elsewhere — fine either way
  }
}

function claimSpool(limit = 50, env = process.env) {
  const dir = spoolDir(env);
  const claimed = [], events = [];
  recoverStaleClaims(dir);
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => /^evt-.*\.json$/.test(f)).sort().slice(0, limit); }
  catch { return { events, claimed }; }
  let bytes = 0;
  for (const name of names) {
    const from = path.join(dir, name);
    let raw;
    try { raw = fs.readFileSync(from, "utf8"); } catch { continue; } // gone/raced before we could read it
    // Stop claiming once the batch would cross the ingest-safe byte budget; leave the rest for
    // the next flush rather than building an oversized batch the server will 413 forever.
    // Always let the first item through so one file can't wedge the queue by itself.
    if (claimed.length > 0 && bytes + raw.length > CLAIM_MAX_BYTES) break;
    const to = `${from}.claim-${process.pid}`;
    try { fs.renameSync(from, to); } catch { continue; } // raced: another sender claimed it
    try { events.push(JSON.parse(raw)); claimed.push(to); bytes += raw.length; }
    catch { try { fs.unlinkSync(to); } catch {} } // corrupt file: drop it
  }
  return { events, claimed };
}
function removeClaims(claimed) { for (const p of claimed) { try { fs.unlinkSync(p); } catch {} } }
function releaseClaims(claimed) {
  for (const p of claimed) { try { fs.renameSync(p, p.replace(/\.claim-\d+$/, "")); } catch {} }
}

module.exports = {
  readStdin, teamMemDir, loadSettings, normalizeRemote, repoKeyFor, gitBranch, matchPattern, isAllowed, redact, cap, capHeadTail,
  shouldSkipTool, buildEvent, writeSpoolEvent, claimSpool, removeClaims, releaseClaims,
};
