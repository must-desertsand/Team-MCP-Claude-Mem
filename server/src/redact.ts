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

/**
 * A captured key=value value counts as a secret literal only when it looks like
 * one (secret-safe charset, >=6 chars, and a digit / symbol / mixed case).
 * Code and prose mention these keys constantly ("readonly token: string;",
 * "const apiKey = process.env.API_KEY;") and must survive intact.
 */
const SECRET_VALUE_CHARSET = /^[A-Za-z0-9_\-./+=~!@#$%^&*]{6,}$/;
const NON_SECRET_KEY_SUFFIX = /(name|header|path|file|id|url|type|kind|label|field|param|prefix|format)["']?\s*[:=]\s*["']?$/i;
const IDENTIFIER_VALUE = /^(?:[a-z0-9]+(?:-[a-z0-9]+)+|[a-z0-9]+(?:_[a-z0-9]+)+|[A-Z0-9_]+)$/;
const SCHEME_WORD = /^(?:bearer|basic|digest|token|none|null|true|false|undefined)$/i;
function looksLikeSecretValue(key: string, value: string): boolean {
  if (NON_SECRET_KEY_SUFFIX.test(key)) return false;
  if (!SECRET_VALUE_CHARSET.test(value)) return false;
  if (/^process\.env\./i.test(value)) return false;
  if (IDENTIFIER_VALUE.test(value) || SCHEME_WORD.test(value)) return false;
  const mixedCase = value.length >= 8 && /[a-z]/.test(value) && /[A-Z]/.test(value);
  return /\d/.test(value) || /[^A-Za-z0-9]/.test(value) || mixedCase;
}
function looksLikeBearerToken(token: string): boolean {
  return /\d/.test(token) || /[^A-Za-z]/.test(token) || token.length >= 20;
}

/** Git SHA-1 / SHA-256 content hashes are not secrets: hex, exactly 40 or 64 chars, either case. */
function isContentHash(run: string): boolean {
  return /^[0-9a-fA-F]{40}$/.test(run) || /^[0-9a-fA-F]{64}$/.test(run);
}

export function redact(text: string): string {
  if (!text) return text;
  let t = String(text);
  t = t.replace(/-----BEGIN [A-Z ]*KEY-----[\s\S]*?-----END [A-Z ]*KEY-----/g, "[REDACTED]");
  t = t.replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[REDACTED]");
  t = t.replace(/\b(?:xox[abeprs]|xapp)-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]");
  t = t.replace(/(:\/\/[^/\s:@"']+:)[^/\s@"']+(@)/g, "$1[REDACTED]$2");
  t = t.replace(/\bbearer\s+([A-Za-z0-9._~+/-]{4,}=*)/gi, (m, tok: string) => (looksLikeBearerToken(tok) ? "[REDACTED]" : m));
  t = t.replace(
    /([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([^\s"']+)/gi,
    (match, key: string, value: string) => (looksLikeSecretValue(key, value) ? `${key}[REDACTED]` : match),
  );
  t = t.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]");
  t = t.replace(/eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[REDACTED]");
  t = t.replace(/[A-Za-z0-9+]{40,}={0,2}/g, (run) => (isContentHash(run) ? run : "[REDACTED]"));
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
