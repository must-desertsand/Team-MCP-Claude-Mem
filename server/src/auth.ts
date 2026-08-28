import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { UserRow } from "./db";

export type Role = "member" | "service" | "admin";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createUser(db: Database, name: string, role: Role = "member") {
  const token = "tm_" + randomBytes(24).toString("base64url");
  const r = db.query(
    `INSERT INTO users(name, role, token_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id`,
  ).get(name, role, hashToken(token), Date.now()) as { id: number };
  return { id: r.id, name, role, token };
}

export function userByToken(db: Database, token: string | null | undefined): UserRow | null {
  if (!token) return null;
  return (db.query(`SELECT * FROM users WHERE token_hash = ?`).get(hashToken(token)) as UserRow) ?? null;
}

export function revokeUser(db: Database, name: string): boolean {
  const r = db.run(`DELETE FROM users WHERE name = ?`, [name]);
  return r.changes > 0;
}

export function listUsers(db: Database) {
  return db.query(`SELECT id, name, role, created_at FROM users ORDER BY id`).all() as Array<{
    id: number; name: string; role: string; created_at: number;
  }>;
}
