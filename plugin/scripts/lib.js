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
  let u = url.trim().replace(/\.git\/?$/, "");
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

module.exports = {
  readStdin, teamMemDir, loadSettings, normalizeRemote, repoKeyFor, gitBranch, matchPattern, isAllowed, redact, cap, capHeadTail,
};
