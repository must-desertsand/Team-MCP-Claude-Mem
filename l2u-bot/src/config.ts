import 'dotenv/config';
import path from 'node:path';

export interface ModelSpec {
  readonly id: string;
  /** Maximum input tokens. Used to decide when to compact the context. */
  readonly contextWindow: number;
}

export interface Limits {
  readonly maxTurns: number;
  readonly toolResultBytes: number;
  /** Compact once accumulated input exceeds contextWindow * this ratio. */
  readonly contextUsageRatio: number;
  readonly jobTimeoutMs: number;
}

export interface Config {
  readonly slack: {
    readonly botToken: string;
    readonly appToken: string;
    readonly allowedChannels: readonly string[];
  };
  readonly litellm: {
    readonly baseUrl: string;
    readonly apiKey: string;
  };
  readonly models: {
    /** Primary chain, tried in order. */
    readonly chain: readonly ModelSpec[];
    /** Cheap model used to compact bulky tool output. */
    readonly compact: string;
  };
  readonly github: {
    /** Fixed owner/repo. The model cannot change it. */
    readonly repo: string;
  };
  readonly repo: {
    /** Absolute path to the local clone used for code search. */
    readonly clonePath: string;
  };
  /** Team-Mem shared-memory server. Null when no bot token is configured — tools are omitted. */
  readonly teamMem: {
    readonly baseUrl: string;
    readonly token: string;
  } | null;
  readonly limits: Limits;
  readonly auditDir: string;
  /** Days to keep audit logs. 0 disables pruning. */
  readonly auditRetentionDays: number;
}

class ConfigError extends Error {}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new ConfigError(`Required environment variable ${name} is not set. Check your .env file.`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

/** Context limits per model. Unknown models get a conservative default. */
const CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'glm-5.2': 976_000,
  'gemini/gemini-3.1-pro-preview': 1_000_000,
  'gemini/gemini-3.5-flash': 1_000_000,
  'gemini/gemini-3.6-flash': 1_000_000,
  'gemini/gemini-3.7-flash': 1_000_000,
  'gemini/gemini-3.5-flash-lite': 1_000_000,
  'kimi-k2.7-code': 256_000,
  gemma4: 128_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

function parseModelChain(raw: string): readonly ModelSpec[] {
  const ids = raw
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (ids.length === 0) {
    throw new ConfigError('Model chain is empty. Check LITELLM_MODEL_CHAIN.');
  }
  return Object.freeze(
    ids.map((id) => Object.freeze({ id, contextWindow: CONTEXT_WINDOWS[id] ?? DEFAULT_CONTEXT_WINDOW })),
  );
}

function parseChannels(raw: string): readonly string[] {
  return Object.freeze(
    raw
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0),
  );
}

/**
 * Read and validate configuration from the environment.
 * Anything missing fails at startup — better than dying mid-request later.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const clonePath = path.resolve(
    optional('REPO_CLONE_PATH', path.resolve(process.cwd(), '..', 'l2u-project')),
  );

  const allowedChannels = parseChannels(optional('SLACK_ALLOWED_CHANNELS', ''));

  return Object.freeze({
    slack: Object.freeze({
      botToken: required('SLACK_BOT_TOKEN'),
      appToken: required('SLACK_APP_TOKEN'),
      allowedChannels,
    }),
    litellm: Object.freeze({
      baseUrl: optional('LITELLM_BASE_URL', 'https://litellm.must.codes'),
      apiKey: required('LITELLM_KEY'),
    }),
    models: Object.freeze({
      chain: parseModelChain(
        optional('LITELLM_MODEL_CHAIN', 'glm-5.2,gemma4,gemini/gemini-3.5-flash'),
      ),
      compact: optional('LITELLM_COMPACT_MODEL', 'gemini/gemini-3.5-flash-lite'),
    }),
    github: Object.freeze({
      repo: optional('GITHUB_REPO', 'mustfintech/l2u-sandbox'),
    }),
    repo: Object.freeze({ clonePath }),
    // Deliberately TEAM_MEM_BOT_TOKEN, not TEAM_MEM_TOKEN: a teammate's personal
    // plugin token exported in the shell would otherwise override the bot's
    // service token (dotenv never overrides existing process env).
    teamMem:
      env.TEAM_MEM_BOT_TOKEN && env.TEAM_MEM_BOT_TOKEN.trim() !== ''
        ? Object.freeze({
            baseUrl: optional('TEAM_MEM_URL', 'http://127.0.0.1:7337'),
            token: env.TEAM_MEM_BOT_TOKEN.trim(),
          })
        : null,
    limits: Object.freeze({
      maxTurns: Number(optional('MAX_TURNS', '20')),
      toolResultBytes: Number(optional('TOOL_RESULT_BYTES', '20000')),
      contextUsageRatio: 0.6,
      jobTimeoutMs: Number(optional('JOB_TIMEOUT_MS', String(5 * 60_000))),
    }),
    auditDir: path.resolve(optional('AUDIT_DIR', path.resolve(process.cwd(), 'audit'))),
    auditRetentionDays: Number(optional('AUDIT_RETENTION_DAYS', '30')),
  });
}

export { ConfigError };
