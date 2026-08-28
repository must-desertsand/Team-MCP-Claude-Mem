import { z } from "zod";
import type { EventRow, ObservationRow } from "./db";

export const obsDraftSchema = z.array(z.object({
  type: z.enum(["decision", "change", "discovery", "bug", "how-it-works"]),
  title: z.string().min(3).max(200),
  body: z.string().min(3).max(4000),
  files: z.array(z.string().max(300)).max(20).default([]),
  tags: z.array(z.string().max(60)).max(10).default([]),
})).max(15);

export const summaryDraftSchema = z.object({
  body: z.string().min(3).max(4000),
  open_threads: z.string().max(2000).default(""),
});

function renderEvent(e: EventRow): string {
  try {
    const p = JSON.parse(e.payload);
    if (p.kind === "prompt") return `[user prompt] ${p.text ?? ""}`;
    if (p.kind === "tool") return `[tool ${p.tool ?? "?"}] input: ${p.input ?? ""} => ${p.result ?? ""}`;
    return `[session end]`;
  } catch {
    return "[unreadable event]";
  }
}

const EXTRACT_SYSTEM = `You extract durable engineering knowledge from an AI coding session's event log.
Return ONLY a JSON array — no prose, no markdown fences. Each item:
{"type":"decision"|"change"|"discovery"|"bug"|"how-it-works","title":"specific, <=100 chars","body":"2-4 concrete sentences","files":["paths mentioned"],"tags":["lowercase","keywords"]}
Extract 0-10 items. Include only what a teammate benefits from knowing later: decisions made and why, code changes and their intent, discoveries about how the system works, bugs found or fixed, plans agreed. Skip trivia (file listings, formatting, transient errors, tool noise). Return [] if nothing durable happened.`;

export function extractionPrompt(rows: EventRow[]): { system: string; user: string } {
  return { system: EXTRACT_SYSTEM, user: `Session events:\n${rows.map(renderEvent).join("\n")}` };
}

const SUMMARY_SYSTEM = `You write a short handoff summary of an AI coding session for teammates.
Return ONLY a JSON object — no prose, no markdown fences:
{"body":"3-6 sentences: what was worked on, what changed, the outcome","open_threads":"unfinished work / next steps, or empty string"}`;

export function summaryPrompt(obs: ObservationRow[], lastEvents: EventRow[]): { system: string; user: string } {
  const obsLines = obs.map(o => `- ${o.type}: ${o.title} — ${o.body}`).join("\n");
  const evLines = lastEvents.map(renderEvent).join("\n");
  return { system: SUMMARY_SYSTEM, user: `Observations from the session:\n${obsLines}\n\nFinal events:\n${evLines}` };
}

export function extractJson(raw: string): unknown | null {
  const tryParse = (s: string): unknown | null => { try { return JSON.parse(s); } catch { return null; } };
  const direct = tryParse(raw.trim());
  if (direct !== null) return direct;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { const f = tryParse(fence[1].trim()); if (f !== null) return f; }
  for (const [open, close] of [["[", "]"], ["{", "}"]] as const) {
    const a = raw.indexOf(open), b = raw.lastIndexOf(close);
    if (a >= 0 && b > a) { const s = tryParse(raw.slice(a, b + 1)); if (s !== null) return s; }
  }
  return null;
}
