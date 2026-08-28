const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const { join } = require("node:path");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");

const SENDER = join(import.meta.dir, "..", "scripts", "sender.js");

function stubServer(status = 200) {
  const bodies = [];
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      bodies.push({ auth: req.headers.get("authorization"), body: await req.json() });
      return new Response(JSON.stringify({ ok: status === 200 }), { status });
    },
  });
  return { srv, bodies, url: `http://127.0.0.1:${srv.port}` };
}

// NOTE (deviation from brief): the brief's Bun.spawnSync deadlocks here — it blocks this
// process's JS thread while waiting for the child to exit, but the child's fetch is talking
// to the stub Bun.serve() running IN this same process/thread, which then never gets a turn
// to run its fetch handler. Verified with a minimal repro (Bun.spawnSync + in-process
// Bun.serve => child always hits its own client-side timeout, server never sees the request;
// Bun.spawn (async) + await .exited => request completes in ~14ms). Switched to async
// Bun.spawn + awaiting `.exited` so this process's event loop stays free to serve the child's
// request; everything else (args, env, assertions) is unchanged from the brief.
async function runSender(env, argvEvent) {
  const args = [process.execPath, SENDER];
  if (argvEvent) args.push(JSON.stringify(argvEvent));
  const proc = Bun.spawn(args, { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc;
}
const EVT = { kind: "end", session: "sess-12345678", repo: "mustfintech/web", ts: 1 };

describe("sender.js", () => {
  test("sends argv event + spooled events; clears spool on success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tm-send-"));
    const { srv, bodies, url } = stubServer(200);
    process.env.TEAM_MEM_DIR = dir;
    const lib = require("../scripts/lib.js");
    lib.writeSpoolEvent({ ...EVT, ts: 2 });
    lib.writeSpoolEvent({ ...EVT, ts: 3 });
    const r = await runSender({ TEAM_MEM_DIR: dir, TEAM_MEM_URL: url, TEAM_MEM_TOKEN: "tm_x" }, EVT);
    expect(r.exitCode).toBe(0);
    expect(bodies.length).toBe(1);
    expect(bodies[0].auth).toBe("Bearer tm_x");
    expect(bodies[0].body.events.length).toBe(3);
    expect(fs.readdirSync(join(dir, "spool")).length).toBe(0);
    srv.stop();
  });
  test("on failure restores spool and spools the argv event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tm-send-"));
    const { srv, url } = stubServer(500);
    process.env.TEAM_MEM_DIR = dir;
    const lib = require("../scripts/lib.js");
    lib.writeSpoolEvent({ ...EVT, ts: 2 });
    await runSender({ TEAM_MEM_DIR: dir, TEAM_MEM_URL: url, TEAM_MEM_TOKEN: "tm_x" }, EVT);
    const files = fs.readdirSync(join(dir, "spool"));
    expect(files.length).toBe(2);                       // restored + newly spooled
    expect(files.every(f => /^evt-.*\.json$/.test(f))).toBe(true); // no .claim- leftovers
    srv.stop();
  });
  test("unreachable server spools without hanging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tm-send-"));
    const start = Date.now();
    await runSender({ TEAM_MEM_DIR: dir, TEAM_MEM_URL: "http://127.0.0.1:1", TEAM_MEM_TOKEN: "tm_x" }, EVT);
    expect(Date.now() - start).toBeLessThan(4500);
    expect(fs.readdirSync(join(dir, "spool")).length).toBe(1);
  });
  test("off (no token) drops silently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tm-send-"));
    await runSender({ TEAM_MEM_DIR: dir, TEAM_MEM_URL: "http://x" }, EVT);
    expect(fs.existsSync(join(dir, "spool")) ? fs.readdirSync(join(dir, "spool")).length : 0).toBe(0);
  });
});
