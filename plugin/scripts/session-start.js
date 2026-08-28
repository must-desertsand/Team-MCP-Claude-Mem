#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readStdin, loadSettings, repoKeyFor, gitBranch, isAllowed } = require("./lib.js");

async function main() {
  const settings = loadSettings();
  if (settings.off) return;
  let input = {};
  try { input = JSON.parse(await readStdin()); } catch { return; }
  const cwd = input.cwd || process.cwd();
  const repoKey = repoKeyFor(cwd);
  if (!isAllowed(repoKey, settings)) return;   // PRIVACY GATE
  spawn(process.execPath, [path.join(__dirname, "sender.js")], { detached: true, stdio: "ignore" }).unref();
  try {
    const base = settings.url.replace(/\/+$/, "");
    const url = `${base}/context?repo=${encodeURIComponent(repoKey)}&branch=${encodeURIComponent(gitBranch(cwd) || "")}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${settings.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 200) return;
    const text = await res.text();
    if (!text.trim()) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `[team-mem] Team memory briefing:\n${text}`,
      },
    }));
  } catch {}
}
main().catch(() => {}).finally(() => process.exit(0));
