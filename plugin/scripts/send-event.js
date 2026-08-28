#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readStdin, loadSettings, repoKeyFor, gitBranch, isAllowed, buildEvent } = require("./lib.js");

async function main() {
  const kind = process.argv[2];
  if (!["prompt", "tool", "end"].includes(kind)) return;
  const settings = loadSettings();
  if (settings.off) return;
  let input = {};
  try { input = JSON.parse(await readStdin()); } catch { return; }
  const cwd = input.cwd || process.cwd();
  const repoKey = repoKeyFor(cwd);
  if (!isAllowed(repoKey, settings)) return;   // PRIVACY GATE: nothing leaves the machine
  const event = buildEvent(kind, input, repoKey, gitBranch(cwd));
  if (!event) return;
  spawn(process.execPath, [path.join(__dirname, "sender.js"), JSON.stringify(event)], {
    detached: true, stdio: "ignore",
  }).unref();
}
main().catch(() => {}).finally(() => process.exit(0));
