/**
 * Server-side secret redaction and the retrieval trust boundary.
 *
 * Conforming plugins already redact on the client before anything leaves the
 * teammate's machine (plugin/scripts/lib.js — the canonical rule set, with
 * regression tests). This module is DEFENSE IN DEPTH for the two paths that
 * layer cannot cover:
 *
 *   1. A stale, buggy, or non-conforming client shipping raw secrets into the
 *      store → redact() runs again at ingest, so the database never holds them.
 *   2. The compression LLM echoing or generating secret-shaped values →
 *      redact() runs on observations/summaries at insert.
 *
 * tagUntrustedMemory() frames memory content served back into Claude sessions
 * (briefing, MCP tools): entries are teammate-authored, LLM-generated retrieved
 * content — data, never instructions.
 *
 * Rule order matters; keep in sync with plugin/scripts/lib.js.
 */

export function redact(text: string): string {
  if (!text) return text;
  let t = String(text);
  t = t.replace(/-----BEGIN [A-Z ]*KEY-----[\s\S]*?-----END [A-Z ]*KEY-----/g, "[REDACTED]");
  t = t.replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[REDACTED]");
  t = t.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]");
  t = t.replace(/(:\/\/[^/\s:@"']+:)[^/\s@"']+(@)/g, "$1[REDACTED]$2");
  t = t.replace(/\bbearer\s+[A-Za-z0-9._~+/-]{4,}=*/gi, "[REDACTED]");
  t = t.replace(
    /([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([^\s"']+)/gi,
    "$1[REDACTED]",
  );
  t = t.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]");
  t = t.replace(/eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[REDACTED]");
  t = t.replace(/[A-Za-z0-9+]{40,}={0,2}/g, "[REDACTED]");
  return t;
}

const OPEN_TAG = "<untrusted_team_memory>";
const CLOSE_TAG = "</untrusted_team_memory>";

/**
 * Wrap memory content served into a Claude session. Embedded copies of the
 * tags are neutralized first so exactly one pair exists and recorded content
 * cannot fake its way out of the boundary.
 */
export function tagUntrustedMemory(content: string): string {
  const neutralized = String(content).replace(/<(\/?)untrusted_team_memory/g, "<$1untrusted_team_memory_escaped");
  return `${OPEN_TAG}${neutralized}${CLOSE_TAG}`;
}
