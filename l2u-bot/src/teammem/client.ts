/**
 * Read-only client for the Team-Mem server (the team's shared Claude Code memory).
 * Runs on the same machine as the bot, so the default base URL is localhost.
 * Uses a service-role token: the bot can query, never ingest or delete.
 */

interface StatusEntry {
  readonly user: string;
  readonly active: { readonly repo: string; readonly branch: string | null; readonly minutesAgo: number } | null;
  readonly recent: readonly string[];
}

interface SearchHit {
  readonly id: string;
  readonly rel: string;
  readonly user: string;
  readonly repo: string;
  readonly type: string;
  readonly title: string;
}

export interface SearchOptions {
  readonly workspace?: string;
  readonly user?: string;
  readonly type?: string;
  readonly limit?: number;
}

export class TeamMemClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async get(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`;
    const res = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`team-mem ${res.status}`);
    return res.json();
  }

  /** Who has been doing what lately, rendered as plain text for the model. */
  async status(workspace?: string, days?: number): Promise<string> {
    const entries = (await this.get('/api/status', { workspace, days })) as StatusEntry[];
    if (entries.length === 0) return 'No team members found.';
    return entries
      .map((e) => {
        const head = e.active
          ? `${e.user}: ACTIVE now in ${e.active.repo}${e.active.branch ? ` (${e.active.branch})` : ''}, last event ${e.active.minutesAgo} min ago`
          : `${e.user}: not currently active`;
        const recent =
          e.recent.length > 0
            ? e.recent.map((r) => `  recent: ${r}`).join('\n')
            : '  no recent activity recorded';
        return `${head}\n${recent}`;
      })
      .join('\n');
  }

  /** Full-text search over team observations and session summaries. */
  async search(query: string, opts: SearchOptions = {}): Promise<string> {
    const hits = (await this.get('/api/search', {
      q: query,
      workspace: opts.workspace,
      user: opts.user,
      type: opts.type,
      limit: opts.limit,
    })) as SearchHit[];
    if (hits.length === 0) return `No matches in team memory for "${query}".`;
    return hits
      .map((h) => `${h.id} · ${h.user} · ${h.repo} · ${h.rel} · ${h.type}: ${h.title}`)
      .join('\n');
  }
}
