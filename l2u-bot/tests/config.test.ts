import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

const base = {
  SLACK_BOT_TOKEN: 'xoxb-x',
  SLACK_APP_TOKEN: 'xapp-x',
  LITELLM_KEY: 'sk-x',
};

function withEnv(overrides: Record<string, string | undefined>) {
  const saved = { ...process.env };
  Object.keys(process.env).forEach((k) => {
    if (k.startsWith('SLACK_') || k.startsWith('LITELLM_') || k.startsWith('GITHUB_') || k === 'MAX_TURNS' || k === 'REPO_CLONE_PATH') {
      delete process.env[k];
    }
  });
  Object.assign(process.env, base, overrides);
  try {
    return loadConfig();
  } finally {
    process.env = saved;
  }
}

describe('loadConfig', () => {
  it('fails at startup when a required variable is missing', () => {
    expect(() => withEnv({ SLACK_BOT_TOKEN: '' })).toThrow(ConfigError);
  });

  it('treats a whitespace-only value as unset', () => {
    expect(() => withEnv({ LITELLM_KEY: '   ' })).toThrow(ConfigError);
  });

  it('parses the comma-separated model chain and attaches known context limits', () => {
    const c = withEnv({ LITELLM_MODEL_CHAIN: 'glm-5.2,gemma4' });
    expect(c.models.chain.map((m) => m.id)).toEqual(['glm-5.2', 'gemma4']);
    expect(c.models.chain[0]!.contextWindow).toBe(976_000);
    expect(c.models.chain[1]!.contextWindow).toBe(128_000);
  });

  it('falls back to a conservative limit for unknown models', () => {
    const c = withEnv({ LITELLM_MODEL_CHAIN: 'unknown-model' });
    expect(c.models.chain[0]!.contextWindow).toBe(128_000);
  });

  it('rejects an empty model chain', () => {
    expect(() => withEnv({ LITELLM_MODEL_CHAIN: ' , ' })).toThrow(ConfigError);
  });

  it('trims whitespace and empty entries from the allowed channel list', () => {
    expect(withEnv({ SLACK_ALLOWED_CHANNELS: ' C1 , ,C2 ' }).slack.allowedChannels).toEqual(['C1', 'C2']);
  });

  it('treats an empty allowed channel list as unrestricted', () => {
    expect(withEnv({ SLACK_ALLOWED_CHANNELS: '' }).slack.allowedChannels).toEqual([]);
  });

  it('normalizes the repository path to an absolute path', () => {
    expect(withEnv({ REPO_CLONE_PATH: '/tmp/repo' }).repo.clonePath).toBe('/tmp/repo');
  });

  it('defaults the target repository to l2u-sandbox', () => {
    expect(withEnv({}).github.repo).toBe('mustfintech/l2u-sandbox');
  });

  it('allows limits to be overridden by environment variables', () => {
    expect(withEnv({ MAX_TURNS: '7' }).limits.maxTurns).toBe(7);
  });
});
