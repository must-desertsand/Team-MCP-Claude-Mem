import { loadConfig } from "./src/config";
import { openDb } from "./src/db";
import { createUser, listUsers, revokeUser, type Role } from "./src/auth";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const cfg = loadConfig();
mkdirSync(dirname(cfg.dbPath), { recursive: true });
const db = openDb(cfg.dbPath);
const [, , cmd, sub, ...rest] = Bun.argv;

if (cmd === "user" && sub === "add") {
  const name = rest[0];
  const roleIdx = rest.indexOf("--role");
  const role = (roleIdx >= 0 ? rest[roleIdx + 1] : "member") as Role;
  if (!name) { console.error("usage: bun run admin user add <name> [--role member|service|admin]"); process.exit(1); }
  const u = createUser(db, name, role);
  console.log(`created ${u.name} (${u.role})`);
  console.log(`token (shown once): ${u.token}`);
} else if (cmd === "user" && sub === "list") {
  for (const u of listUsers(db)) console.log(`${u.id}\t${u.name}\t${u.role}`);
} else if (cmd === "user" && sub === "revoke") {
  console.log(revokeUser(db, rest[0] ?? "") ? "revoked" : "not found");
} else {
  console.error("usage: bun run admin user add|list|revoke ...");
  process.exit(1);
}
