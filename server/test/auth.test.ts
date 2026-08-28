import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createUser, userByToken, revokeUser, listUsers } from "../src/auth";

describe("auth", () => {
  test("create, lookup, default role", () => {
    const db = openDb(":memory:");
    const { token, role } = createUser(db, "haseeb");
    expect(role).toBe("member");
    expect(token.startsWith("tm_")).toBe(true);
    const u = userByToken(db, token);
    expect(u?.name).toBe("haseeb");
  });
  test("wrong/missing token yields null", () => {
    const db = openDb(":memory:");
    createUser(db, "haseeb");
    expect(userByToken(db, "tm_wrong")).toBeNull();
    expect(userByToken(db, undefined)).toBeNull();
    expect(userByToken(db, "")).toBeNull();
  });
  test("roles and revoke", () => {
    const db = openDb(":memory:");
    const a = createUser(db, "hoyoung", "admin");
    expect(userByToken(db, a.token)?.role).toBe("admin");
    expect(revokeUser(db, "hoyoung")).toBe(true);
    expect(userByToken(db, a.token)).toBeNull();
    expect(revokeUser(db, "ghost")).toBe(false);
    createUser(db, "l2u-work", "service");
    expect(listUsers(db).map(u => u.name)).toEqual(["l2u-work"]);
  });
});
