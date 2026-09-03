import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { buildApp } from "./app";
import { OpenAiCompatProvider } from "./provider";
import { startCompressionLoop } from "./worker";
import { startRetentionLoop } from "./retention";

const cfg = loadConfig();
mkdirSync(dirname(cfg.dbPath), { recursive: true });
const db = openDb(cfg.dbPath);
const app = buildApp(db, cfg);
const provider = new OpenAiCompatProvider(cfg.llmBaseUrl, cfg.llmApiKey, cfg.llmModel);
startCompressionLoop(db, provider, cfg.pollMs);
startRetentionLoop(db);
// idleTimeout: Bun defaults to 10 s, which cuts the MCP client's kept-alive connection
// between calls and makes Claude Code report "failed to reconnect". 255 s is Bun's max.
Bun.serve({ port: cfg.port, fetch: app.fetch, idleTimeout: 255 });
console.log(`team-mem server listening on :${cfg.port} (db: ${cfg.dbPath}, llm: ${cfg.llmBaseUrl} ${cfg.llmModel})`);
