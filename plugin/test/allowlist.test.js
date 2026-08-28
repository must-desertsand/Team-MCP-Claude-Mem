const { describe, expect, test } = require("bun:test");
const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { normalizeRemote, matchPattern, isAllowed, loadSettings } = require("../scripts/lib.js");

describe("normalizeRemote", () => {
  test("handles ssh aliases, https, ssh://, .git, case", () => {
    expect(normalizeRemote("git@github.com-company:mustfintech/l2u-sandbox.git")).toBe("mustfintech/l2u-sandbox");
    expect(normalizeRemote("git@github.com:Owner/Repo.git")).toBe("owner/repo");
    expect(normalizeRemote("https://github.com/mustfintech/web")).toBe("mustfintech/web");
    expect(normalizeRemote("ssh://git@github.com/a/b.git")).toBe("a/b");
    expect(normalizeRemote("github.com-company:must-desertsand/Team-MCP-Claude-Mem.git")).toBe("must-desertsand/team-mcp-claude-mem");
    expect(normalizeRemote("git@github.com:mustfintech/WEB.GIT")).toBe("mustfintech/web");
    expect(normalizeRemote("not a url")).toBeNull();
    expect(normalizeRemote("")).toBeNull();
    expect(normalizeRemote(null)).toBeNull();
  });
});

describe("allowlist", () => {
  const S = { include: ["mustfintech/*", "must-desertsand/*"], exclude: ["mustfintech/secret-repo"] };
  test("matchPattern globs one segment", () => {
    expect(matchPattern("mustfintech/*", "mustfintech/web")).toBe(true);
    expect(matchPattern("mustfintech/*", "otherorg/web")).toBe(false);
    expect(matchPattern("a/b", "a/b")).toBe(true);
  });
  test("isAllowed: include wins unless excluded; null never allowed", () => {
    expect(isAllowed("mustfintech/web", S)).toBe(true);
    expect(isAllowed("must-desertsand/team-mcp-claude-mem", S)).toBe(true);
    expect(isAllowed("personal/side-project", S)).toBe(false);
    expect(isAllowed("mustfintech/secret-repo", S)).toBe(false);
    expect(isAllowed(null, S)).toBe(false);
  });
});

describe("loadSettings", () => {
  test("env + config.json merge; off flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "tm-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ exclude: ["mustfintech/x"], include: ["extra/repo"] }));
    const env = { TEAM_MEM_DIR: dir, TEAM_MEM_URL: "http://s:7337", TEAM_MEM_TOKEN: "tm_t" };
    const s = loadSettings(env);
    expect(s.off).toBe(false);
    expect(s.url).toBe("http://s:7337");
    expect(s.include).toContain("mustfintech/*");   // from plugin allowlist.json
    expect(s.include).toContain("extra/repo");       // from local config
    expect(s.exclude).toEqual(["mustfintech/x"]);
    expect(loadSettings({ ...env, TEAM_MEM_OFF: "1" }).off).toBe(true);
    expect(loadSettings({ TEAM_MEM_DIR: dir }).off).toBe(true); // no url/token
    const dir2 = mkdtempSync(join(tmpdir(), "tm-"));
    writeFileSync(join(dir2, "config.json"), JSON.stringify({ disabled: true }));
    expect(loadSettings({ ...env, TEAM_MEM_DIR: dir2 }).off).toBe(true);
  });
});
