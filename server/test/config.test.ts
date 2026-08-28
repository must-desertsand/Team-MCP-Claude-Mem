import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("applies defaults", () => {
    const c = loadConfig({});
    expect(c.port).toBe(7337);
    expect(c.llmModel).toBe("glm-5.2");
    expect(c.llmMaxConcurrent).toBe(1);
    expect(c.pollMs).toBe(15000);
    expect(c.dbPath.endsWith("/.team-mem-server/data.db")).toBe(true);
    expect(c.workspacesPath.endsWith("workspaces.json")).toBe(true);
  });
  test("env overrides win", () => {
    const c = loadConfig({ PORT: "9000", LLM_MODEL: "x", DB_PATH: "/tmp/t.db", POLL_MS: "500" });
    expect(c.port).toBe(9000);
    expect(c.llmModel).toBe("x");
    expect(c.dbPath).toBe("/tmp/t.db");
    expect(c.pollMs).toBe(500);
  });
});
