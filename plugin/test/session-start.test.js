const { describe, expect, test } = require("bun:test");
const { execSync } = require("node:child_process");
const { join } = require("node:path");
const { mkdtempSync, readFileSync, readdirSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");

const SCRIPT = join(import.meta.dir, "..", "scripts", "session-start.js");

function gitRepo(remote) {
  const dir = mkdtempSync(join(tmpdir(), "tm-repo-"));
  execSync(`git init -q && git remote add origin ${remote}`, { cwd: dir });
  return dir;
}

// NOTE (deviation from brief, same reasoning as plugin/test/sender.test.js): the brief's
// Bun.spawnSync deadlocks against an in-process Bun.serve() stub on this Bun version/platform
// (parent thread blocks waiting for the child while the stub's fetch handler — which needs that
// same thread — never gets to run). Switched to async Bun.spawn + awaiting `.exited`, reading
// stdout via `new Response(proc.stdout).text()` concurrently (needed here, unlike sender.test.js,
// because this script's stdout is the thing under test). Args/env/assertions otherwise unchanged.
async function run(env, stdinObj) {
  const proc = Bun.spawn([process.execPath, SCRIPT], {
    env: { ...process.env, ...env },
    stdin: Buffer.from(JSON.stringify(stdinObj)),
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { out, code };
}

describe("session-start.js", () => {
  test("emits briefing as additionalContext for allowed repo", async () => {
    const hits = [];
    const srv = Bun.serve({
      port: 0,
      fetch: (req) => { hits.push(new URL(req.url).pathname);
        return new URL(req.url).pathname === "/context"
          ? new Response("## Team activity\n- yameen changed auth")
          : new Response(JSON.stringify({ ok: true })); },
    });
    const cwd = gitRepo("git@github.com-company:mustfintech/web.git");
    const dir = mkdtempSync(join(tmpdir(), "tm-ss-"));
    const { out, code } = await run(
      { TEAM_MEM_DIR: dir, TEAM_MEM_URL: `http://127.0.0.1:${srv.port}`, TEAM_MEM_TOKEN: "tm_x" },
      { session_id: "sess-12345678", cwd },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("yameen changed auth");
    expect(hits).toContain("/context");
    srv.stop();
  });
  test("silent for non-team repo: no output, no network", async () => {
    const hits = [];
    const srv = Bun.serve({ port: 0, fetch: () => { hits.push(1); return new Response(""); } });
    const cwd = gitRepo("git@github.com:someone/personal.git");
    const dir = mkdtempSync(join(tmpdir(), "tm-ss-"));
    const { out, code } = await run(
      { TEAM_MEM_DIR: dir, TEAM_MEM_URL: `http://127.0.0.1:${srv.port}`, TEAM_MEM_TOKEN: "tm_x" },
      { session_id: "sess-12345678", cwd },
    );
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
    expect(hits.length).toBe(0);
    srv.stop();
  });
  test("silent when server is down", async () => {
    const cwd = gitRepo("git@github.com-company:mustfintech/web.git");
    const dir = mkdtempSync(join(tmpdir(), "tm-ss-"));
    const { out, code } = await run(
      { TEAM_MEM_DIR: dir, TEAM_MEM_URL: "http://127.0.0.1:1", TEAM_MEM_TOKEN: "tm_x" },
      { session_id: "sess-12345678", cwd },
    );
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
  });

  // Additional tests beyond the brief's Step 1 (given tests only cover the 200 path, the
  // privacy gate, and a down server). These exercise two properties the task's self-review
  // explicitly calls out that the brief's verbatim tests don't reach:
  //   (a) the spool flush is spawned regardless of the briefing outcome (here: a 200/empty
  //       "silent" outcome that isn't the down-server case already covered above), and
  //   (b) output stays silent on a non-200 status generally, using 400 as the second concrete
  //       case (204 is exercised by test (a) below).
  test("spawns a spool flush even when the briefing itself is silent (204)", async () => {
    const hits = [];
    const srv = Bun.serve({
      port: 0,
      fetch: (req) => {
        const p = new URL(req.url).pathname;
        hits.push(p);
        return p === "/context" ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ ok: true }));
      },
    });
    const cwd = gitRepo("git@github.com-company:mustfintech/web.git");
    const dir = mkdtempSync(join(tmpdir(), "tm-ss-"));
    process.env.TEAM_MEM_DIR = dir;
    const lib = require("../scripts/lib.js");
    lib.writeSpoolEvent({ kind: "end", session: "sess-12345678", repo: "mustfintech/web", ts: 1 });
    const { out, code } = await run(
      { TEAM_MEM_DIR: dir, TEAM_MEM_URL: `http://127.0.0.1:${srv.port}`, TEAM_MEM_TOKEN: "tm_x" },
      { session_id: "sess-12345678", cwd },
    );
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
    // The flush runs in a detached, unref'd grandchild (session-start.js -> sender.js) that
    // this test's own child-await doesn't wait on, so poll (bounded) instead of asserting
    // immediately or sleeping a fixed duration.
    const deadline = Date.now() + 3000;
    let remaining = existsSync(join(dir, "spool")) ? readdirSync(join(dir, "spool")).length : 0;
    while (remaining !== 0 && Date.now() < deadline) {
      await Bun.sleep(50);
      remaining = existsSync(join(dir, "spool")) ? readdirSync(join(dir, "spool")).length : 0;
    }
    expect(remaining).toBe(0);
    expect(hits).toContain("/ingest");
    srv.stop();
  });
  test("silent when /context returns 400 (bad repo key)", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: (req) => new URL(req.url).pathname === "/context"
        ? new Response("bad repo", { status: 400 })
        : new Response(JSON.stringify({ ok: true })),
    });
    const cwd = gitRepo("git@github.com-company:mustfintech/web.git");
    const dir = mkdtempSync(join(tmpdir(), "tm-ss-"));
    const { out, code } = await run(
      { TEAM_MEM_DIR: dir, TEAM_MEM_URL: `http://127.0.0.1:${srv.port}`, TEAM_MEM_TOKEN: "tm_x" },
      { session_id: "sess-12345678", cwd },
    );
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
    srv.stop();
  });
});

describe("manifests", () => {
  test("hooks.json wires the four hooks", () => {
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, "..", "hooks", "hooks.json"), "utf8")).hooks;
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "SessionEnd", "SessionStart", "UserPromptSubmit"]);
    expect(hooks.SessionStart[0].matcher).toBe("startup|clear|compact");
    expect(hooks.PostToolUse[0].hooks[0].command).toContain("send-event.js\" tool");
    expect(hooks.SessionEnd[0].hooks[0].command).toContain("send-event.js\" end");
  });
  test("mcp + plugin + marketplace manifests parse", () => {
    const mcp = JSON.parse(readFileSync(join(import.meta.dir, "..", ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["team-memory"].type).toBe("http");
    expect(mcp.mcpServers["team-memory"].url).toContain("${TEAM_MEM_URL");
    const plugin = JSON.parse(readFileSync(join(import.meta.dir, "..", ".claude-plugin", "plugin.json"), "utf8"));
    expect(plugin.name).toBe("team-mem");
    const marketplace = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", ".claude-plugin", "marketplace.json"), "utf8"));
    expect(marketplace.plugins[0].name).toBe("team-mem");
    expect(marketplace.plugins[0].source).toBe("./plugin");
  });
});
