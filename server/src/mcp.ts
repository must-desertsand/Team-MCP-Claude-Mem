import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { teamStatus, teamSearch, teamTimeline, teamGet } from "./query";
import { tagUntrustedMemory } from "./redact";

function text(data: unknown) {
  const raw = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  // Memory content is teammate-authored retrieved data; frame it as such for the
  // querying agent, with embedded tag copies neutralized.
  return { content: [{ type: "text" as const, text: tagUntrustedMemory(raw) }] };
}

export function buildMcpServer(db: Database): McpServer {
  const server = new McpServer({ name: "team-memory", version: "0.1.0" });
  server.registerTool("team_status", {
    description: "Who on the team has been doing what lately (live sessions + recent session summaries). Start here for 'what is X working on?'.",
    inputSchema: {
      workspace: z.string().optional(),
      days: z.number().int().min(1).max(30).optional(),
    },
  }, async (args) => text(teamStatus(db, args)));

  server.registerTool("team_search", {
    description: "Full-text search over the team's observations and session summaries. Returns compact hits; pass ids to team_get for full bodies.",
    inputSchema: {
      query: z.string(),
      workspace: z.string().optional(),
      user: z.string().optional(),
      type: z.enum(["decision", "change", "discovery", "bug", "how-it-works", "summary"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
  }, async (args) => text(teamSearch(db, args)));

  server.registerTool("team_timeline", {
    description: "Chronological observations around an anchor id (from team_search) or within a session.",
    inputSchema: {
      anchor_id: z.string().optional(),
      session_id: z.string().optional(),
      before: z.number().int().min(0).max(20).optional(),
      after: z.number().int().min(0).max(20).optional(),
    },
  }, async (args) => text(teamTimeline(db, {
    anchorId: args.anchor_id, sessionId: args.session_id, before: args.before, after: args.after,
  })));

  server.registerTool("team_get", {
    description: "Fetch full bodies for up to 10 ids from team_search/team_timeline, e.g. [\"o12\",\"s3\"].",
    inputSchema: { ids: z.array(z.string()).min(1).max(10) },
  }, async (args) => text(teamGet(db, args.ids)));

  return server;
}
