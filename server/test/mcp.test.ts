import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createUser } from "../src/auth";
import { ensureProject } from "../src/projects";
import { buildApp } from "../src/app";
import type { Config } from "../src/config";

const CFG: Config = { port: 0, dbPath: ":memory:", llmBaseUrl: "", llmApiKey: "", llmModel: "",
  llmMaxConcurrent: 1, pollMs: 999999, workspacesPath: "/nonexistent.json" };

function parseMcpBody(raw: string): any {
  const dataLines = raw.trim().split("\n").filter(l => l.startsWith("data:"));
  if (dataLines.length) return JSON.parse(dataLines[dataLines.length - 1].slice(5).trim());
  return JSON.parse(raw);
}

function setup() {
  const db = openDb(":memory:");
  const me = createUser(db, "haseeb");
  const p = ensureProject(db, "mustfintech/web", {});
  db.run(`INSERT INTO sessions(id,user_id,project_id,started_at,last_event_at) VALUES ('s1',?,?,1,1)`, [me.id, p.id]);
  db.run(`INSERT INTO observations(session_id,user_id,project_id,ts,type,title,body)
          VALUES ('s1',?,?,?,?,?,?)`, [me.id, p.id, 5, "decision", "moved auth to JWT", "details"]);
  const app = buildApp(db, CFG);
  let sessionHeader: string | null = null;
  const call = async (body: unknown) => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${me.token}`,
        ...(sessionHeader ? { "mcp-session-id": sessionHeader } : {}),
      },
      body: JSON.stringify(body),
    });
    sessionHeader = res.headers.get("mcp-session-id") ?? sessionHeader;
    const text = await res.text();
    return { status: res.status, json: text ? parseMcpBody(text) : null };
  };
  return { call, me, app };
}

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

describe("/mcp", () => {
  test("requires auth", async () => {
    const { app } = setup();
    const res = await app.request("/mcp", { method: "POST", body: JSON.stringify(INIT) });
    expect(res.status).toBe(401);
  });
  test("initialize, list tools, call team_search", async () => {
    const { call } = setup();
    const init = await call(INIT);
    expect(init.json.result.serverInfo.name).toBe("team-memory");
    await call({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = list.json.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["team_get", "team_search", "team_status", "team_timeline"]);
    const search = await call({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "team_search", arguments: { query: "JWT" } },
    });
    expect(search.json.result.content[0].text).toContain("moved auth to JWT");
  });
});
