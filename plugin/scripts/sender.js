#!/usr/bin/env node
"use strict";
const { loadSettings, claimSpool, removeClaims, releaseClaims, writeSpoolEvent } = require("./lib.js");

async function main() {
  const settings = loadSettings();
  if (settings.off) return;
  let argvEvent = null;
  if (process.argv[2]) { try { argvEvent = JSON.parse(process.argv[2]); } catch {} }
  const { events: spooled, claimed } = claimSpool();
  const events = [...(argvEvent ? [argvEvent] : []), ...spooled];
  if (events.length === 0) return;
  try {
    const res = await fetch(`${settings.url.replace(/\/+$/, "")}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.token}` },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(String(res.status));
    removeClaims(claimed);
  } catch {
    releaseClaims(claimed);
    if (argvEvent) writeSpoolEvent(argvEvent);
  }
}
main().catch(() => {}).finally(() => process.exit(0));
