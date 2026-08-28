const { describe, expect, test, beforeEach } = require("bun:test");
const fs = require("node:fs");
const { join } = require("node:path");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tm-spool-"));
  process.env.TEAM_MEM_DIR = dir;
});
const lib = require("../scripts/lib.js");

describe("buildEvent", () => {
  const input = (over = {}) => ({ session_id: "sess-12345678", ...over });
  test("prompt event is capped and redacted", () => {
    const e = lib.buildEvent("prompt", input({ prompt: "password=hunter2 " + "x".repeat(5000) }), "mustfintech/web", "main");
    expect(e.kind).toBe("prompt");
    expect(e.repo).toBe("mustfintech/web");
    expect(e.branch).toBe("main");
    expect(e.text).toContain("password=[REDACTED]");
    expect(e.text.length).toBeLessThanOrEqual(4000);
    expect(JSON.stringify(e).length).toBeLessThanOrEqual(8192);
  });
  test("tool event; skip list and team-memory echo are dropped", () => {
    const e = lib.buildEvent("tool", input({ tool_name: "Edit", tool_input: { file_path: "a.ts" }, tool_response: "ok ".repeat(2000) }), "mustfintech/web", null);
    expect(e.tool).toBe("Edit");
    expect(e.result).toContain("…[snip]…");
    expect(lib.buildEvent("tool", input({ tool_name: "TodoWrite" }), "mustfintech/web", null)).toBeNull();
    expect(lib.buildEvent("tool", input({ tool_name: "mcp__team-memory__team_search" }), "mustfintech/web", null)).toBeNull();
  });
  test(".env reads are fully redacted", () => {
    const e = lib.buildEvent("tool", input({ tool_name: "Read", tool_input: { file_path: "/app/.env.local" }, tool_response: "SECRET=x" }), "mustfintech/web", null);
    expect(e.result).toBe("[REDACTED .env file]");
  });
  test("missing session id yields null", () => {
    expect(lib.buildEvent("prompt", { prompt: "hi" }, "mustfintech/web", null)).toBeNull();
  });
  test("final cap is authoritative even when redaction grows text past the pre-cap length", () => {
    // "token=1" (7 chars) -> redact() -> "token=[REDACTED]" (16 chars): +9 chars growth.
    // Base prompt sits just under the 4000 cap, so the pre-fix `redact(cap(x,4000))` ordering
    // let that growth push the final text past 4000; the fix caps again, after redact, for real.
    // The marker sits near the start (not the tail) so the truncation point -- which lands near
    // the end of the padding once the final cap fires -- can never cut through the token itself.
    const marker = "token=1 ";
    const filler = "lorem ipsum dolor sit amet ".repeat(300).slice(0, 3999 - marker.length);
    const prompt = marker + filler;
    expect(prompt.length).toBe(3999); // sanity-check the fixture itself: under the 4000 pre-cap
    const e = lib.buildEvent("prompt", input({ prompt }), "mustfintech/web", null);
    expect(e.text.length).toBeLessThanOrEqual(4000);
    expect(e.text).toContain("token=[REDACTED]");
  });
});

describe("spool", () => {
  test("write, claim, remove, release round-trip", () => {
    lib.writeSpoolEvent({ kind: "end", n: 1 });
    lib.writeSpoolEvent({ kind: "end", n: 2 });
    const c1 = lib.claimSpool();
    expect(c1.events.length).toBe(2);
    expect(lib.claimSpool().events.length).toBe(0); // already claimed
    lib.releaseClaims(c1.claimed);
    const c2 = lib.claimSpool();
    expect(c2.events.length).toBe(2);
    lib.removeClaims(c2.claimed);
    expect(lib.claimSpool().events.length).toBe(0);
    expect(fs.readdirSync(join(dir, "spool")).length).toBe(0);
  });
  test("prunes oldest beyond 5MB", () => {
    const big = "x".repeat(1024 * 1024);
    for (let i = 0; i < 6; i++) {
      lib.writeSpoolEvent({ kind: "prompt", pad: big, i });
      const t = new Date(Date.now() - (6 - i) * 60_000);
      for (const f of fs.readdirSync(join(dir, "spool"))) {
        const p = join(dir, "spool", f);
        if (fs.statSync(p).mtimeMs > t.getTime()) fs.utimesSync(p, t, t);
      }
    }
    const total = fs.readdirSync(join(dir, "spool"))
      .reduce((s, f) => s + fs.statSync(join(dir, "spool", f)).size, 0);
    expect(total).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
  test("prune never evicts a claimed (in-flight) file, even when eviction crosses 5MB", () => {
    const big = "x".repeat(1024 * 1024); // ~1MB pad
    lib.writeSpoolEvent({ kind: "prompt", pad: big, tag: "claim-me" });
    const c = lib.claimSpool(1);
    expect(c.events.length).toBe(1);
    expect(c.claimed.length).toBe(1);
    const claimedPath = c.claimed[0];
    expect(fs.existsSync(claimedPath)).toBe(true);
    // Push unclaimed spool well past 5MB so pruning must actually evict something.
    for (let i = 0; i < 6; i++) lib.writeSpoolEvent({ kind: "prompt", pad: big, i });
    expect(fs.existsSync(claimedPath)).toBe(true); // survived pruning while claimed
    const unclaimedTotal = fs.readdirSync(join(dir, "spool"))
      .filter(f => /^evt-.*\.json$/.test(f))
      .reduce((s, f) => s + fs.statSync(join(dir, "spool", f)).size, 0);
    expect(unclaimedTotal).toBeLessThanOrEqual(5 * 1024 * 1024);
    lib.releaseClaims([claimedPath]);
    expect(fs.existsSync(claimedPath)).toBe(false);
    const restoredName = claimedPath.replace(/\.claim-\d+$/, "");
    expect(fs.existsSync(restoredName)).toBe(true);
    expect(JSON.parse(fs.readFileSync(restoredName, "utf8")).tag).toBe("claim-me");
  });
  test("claimSpool recovers a stale claim file (crashed sender) and reclaims it", () => {
    fs.mkdirSync(join(dir, "spool"), { recursive: true });
    const p = join(dir, "spool", "evt-1-1-abc123.json.claim-99999");
    fs.writeFileSync(p, JSON.stringify({ kind: "end", stale: true }));
    const old = new Date(Date.now() - 11 * 60_000); // 11 minutes ago, past the 10-minute threshold
    fs.utimesSync(p, old, old);
    const c = lib.claimSpool();
    expect(c.events.length).toBe(1);
    expect(c.events[0].stale).toBe(true);
    expect(c.claimed.length).toBe(1);
    expect(c.claimed[0].endsWith(`.claim-${process.pid}`)).toBe(true); // reclaimed under our pid
  });
  test("claimSpool stops before the accumulated batch would exceed the 200KB ingest-safe budget", () => {
    for (let i = 0; i < 30; i++) lib.writeSpoolEvent({ kind: "prompt", i, pad: "y".repeat(7900) });
    expect(fs.readdirSync(join(dir, "spool")).length).toBe(30);
    const c = lib.claimSpool();
    const totalBytes = c.events.reduce((s, e) => s + JSON.stringify(e).length, 0);
    expect(totalBytes).toBeLessThanOrEqual(200_000);
    expect(c.claimed.length).toBeLessThan(30);
    const remainingUnclaimed = fs.readdirSync(join(dir, "spool")).filter(f => /^evt-.*\.json$/.test(f));
    expect(remainingUnclaimed.length).toBe(30 - c.claimed.length);
    expect(remainingUnclaimed.length).toBeGreaterThan(0);
  });
});
