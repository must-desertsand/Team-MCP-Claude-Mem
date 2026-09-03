const { describe, expect, test } = require("bun:test");
const { redact, cap, capHeadTail } = require("../scripts/lib.js");

describe("redact", () => {
  const cases = [
    ["password=hunter2 rest", "password=[REDACTED] rest"],
    ["api_key: abc123 x", "api_key: [REDACTED] x"],
    ["AKIAIOSFODNN7EXAMPLE", "[REDACTED]"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N65", "jwt [REDACTED]"],
    ["Bearer abcdefgh1234567890", "[REDACTED]"],
    ["ghp_" + "a".repeat(36), "[REDACTED]"],
    ["xoxb-" + "b".repeat(20), "[REDACTED]"],
  ];
  for (const [input, want] of cases) {
    test(`redacts: ${input.slice(0, 30)}`, () => expect(redact(input)).toBe(want));
  }
  test("redacts userinfo in a connection URL but keeps host/path", () => {
    expect(redact("postgres://l2u:S3cretPw@db.seoul:5432/app")).toBe("postgres://l2u:[REDACTED]@db.seoul:5432/app");
  });
  test("leaves a normal URL without userinfo unchanged", () => {
    const url = "https://github.com/mustfintech/web";
    expect(redact(url)).toBe(url);
  });
  test("redacts PEM blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nlines\n-----END RSA PRIVATE KEY-----";
    expect(redact(`before\n${pem}\nafter`)).toBe("before\n[REDACTED]\nafter");
  });
  test("redacts long unbroken token runs but keeps file paths", () => {
    expect(redact("x".repeat(45))).toBe("[REDACTED]");
    const p = "/Users/cb/Projects/Must/team-mcp-claude-mem/server/src/index.ts";
    expect(redact(p)).toBe(p);
  });
  test("keeps normal prose", () => {
    const s = "We changed the auth flow to return a session object.";
    expect(redact(s)).toBe(s);
  });
  test("redacts lowercase bearer tokens", () => {
    const token = "a".repeat(30);
    const result = redact("Authorization: bearer " + token);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain(token);
  });
  test("redacts Bearer tokens under 8 chars", () => {
    expect(redact("Bearer abc12")).toBe("[REDACTED]");
  });
  test("redacts compound key names with slash-bearing values", () => {
    expect(redact("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe("aws_secret_access_key = [REDACTED]");
  });
});

describe("caps", () => {
  test("cap cuts with ellipsis only when needed", () => {
    expect(cap("short", 10)).toBe("short");
    expect(cap("a".repeat(20), 10).length).toBe(10);
    expect(cap("a".repeat(20), 10).endsWith("…")).toBe(true);
  });
  test("capHeadTail keeps head and tail with snip marker", () => {
    const s = "H".repeat(1200) + "T".repeat(600);
    const out = capHeadTail(s, 1500, 1000, 500);
    expect(out.startsWith("H".repeat(100))).toBe(true);
    expect(out.endsWith("T".repeat(100))).toBe(true);
    expect(out).toContain("…[snip]…");
    expect(out.length).toBeLessThan(1600);
    expect(capHeadTail("small", 1500, 1000, 500)).toBe("small");
  });
});

describe("sensitive-file blocklist breadth", () => {
  const lib = require("../scripts/lib.js");
  const blocked = [
    "/app/.env.production", "certs/server.pem", "deploy/signing.key",
    "/Users/x/.ssh/id_rsa", ".npmrc", "ops/credentials", "gcp/credentials.json",
    "service-account-prod.json", "config/secrets.yaml", "app.keystore",
  ];
  const allowed = [
    "src/env.ts", "docs/environment.md", "envoy.yaml", "src/config.ts",
    "backend/src/auth/keys.controller.ts", "tests/secrets.test.ts",
  ];
  for (const f of blocked) {
    test(`blocks ${f}`, () => expect(lib.isSensitiveRead({ file_path: f })).toBe(true));
  }
  for (const f of allowed) {
    test(`allows ${f}`, () => expect(lib.isSensitiveRead({ file_path: f })).toBe(false));
  }
  test("buildEvent suppresses a blocked read's content entirely", () => {
    const e = lib.buildEvent("tool", {
      session_id: "sess-12345678", tool_name: "Read",
      tool_input: { file_path: "certs/server.pem" },
      tool_response: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    }, "mustfintech/web", null);
    expect(e.result).toBe("[REDACTED sensitive file]");
  });
});

describe("precision (from l2u-bot PR #1 review)", () => {
  const { redact } = require("../scripts/lib.js");
  test("keeps git hashes, code, and prose intact", () => {
    for (const s of [
      "commit 3f28c22a9b1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f fixes the bug",
      "readonly token: string;",
      "const apiKey = process.env.API_KEY;",
      "const secret = computeSecret(a, b);",
    ]) expect(redact(s)).toBe(s);
  });
  test("still catches real literals and newer Slack prefixes", () => {
    expect(redact('const apiKey = "sk_live_abc123XYZ";')).toBe('const apiKey = "[REDACTED]";');
    expect(redact("xapp-1-A0123456789-abcdefghij")).toBe("[REDACTED]");
    expect(redact("xoxe-1234567890-abcdefghijkl")).toBe("[REDACTED]");
  });
});

describe("precision round 2 (l2u-bot PR #1 review)", () => {
  const lib = require("../scripts/lib.js");
  test("prose, names, identifiers survive; templates readable; source 'credentials.ts' readable", () => {
    for (const s of ["Send the bearer token in the Authorization header", 'API_TOKEN_HEADER = "x-api-token"', "secretName: my-app-secrets"]) {
      expect(lib.redact(s)).toBe(s);
    }
    expect(lib.redact("Bearer abc12")).toBe("[REDACTED]");
    expect(lib.isSensitiveRead({ file_path: ".env.example" })).toBe(false);
    expect(lib.isSensitiveRead({ file_path: "src/auth/credentials.ts" })).toBe(false);
    expect(lib.isSensitiveRead({ file_path: ".aws/credentials" })).toBe(true);
    expect(lib.isSensitiveRead({ file_path: "backend/.env" })).toBe(true);
  });
});
