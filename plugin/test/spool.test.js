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
});
