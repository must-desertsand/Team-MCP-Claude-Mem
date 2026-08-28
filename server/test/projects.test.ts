import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { REPO_KEY_RE, loadWorkspaces, workspaceFor, ensureProject } from "../src/projects";

const MAP = { l2u: ["mustfintech/web", "mustfintech/app"] };

describe("projects", () => {
  test("repo key regex", () => {
    expect(REPO_KEY_RE.test("mustfintech/web")).toBe(true);
    expect(REPO_KEY_RE.test("Must-Desertsand/Team-MCP-Claude-Mem")).toBe(true);
    expect(REPO_KEY_RE.test("no-slash")).toBe(false);
    expect(REPO_KEY_RE.test("a/b/c")).toBe(false);
  });
  test("workspaceFor: mapped and fallback", () => {
    expect(workspaceFor("mustfintech/web", MAP)).toBe("l2u");
    expect(workspaceFor("mustfintech/other-repo", MAP)).toBe("other-repo");
  });
  test("loadWorkspaces tolerates missing file", () => {
    expect(loadWorkspaces("/nonexistent/nope.json")).toEqual({});
  });
  test("ensureProject is an idempotent upsert", () => {
    const db = openDb(":memory:");
    const a = ensureProject(db, "mustfintech/web", MAP);
    const b = ensureProject(db, "mustfintech/web", MAP);
    expect(a.id).toBe(b.id);
    expect(a.workspace).toBe("l2u");
    const rows = db.query(`SELECT * FROM projects`).all();
    expect(rows.length).toBe(1);
  });
});
