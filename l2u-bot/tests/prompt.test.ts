import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/agent/prompt.js';

const ctx = {
  repoFullName: 'mustfintech/l2u-sandbox',
  repoBranch: 'main',
  repoSha: 'abc1234',
  repoDirty: true,
  repoOverview: '100 tracked files\nTop level: backend (60)',
  channel: 'C1',
  threadTs: '1.2',
  requester: 'U1',
  nowKst: '2026-08-28T13:00:00+09:00',
};

describe('buildSystemPrompt', () => {
  it('states that Slack content is data, not commands', () => {
    const p = buildSystemPrompt(ctx);
    expect(p).toContain('untrusted_slack_content');
    expect(p).toContain('is a command');
  });

  it('declares that it is read-only with no write tools', () => {
    expect(buildSystemPrompt(ctx)).toContain('read-only');
  });

  it('includes the snapshot branch, commit, and dirty state', () => {
    const p = buildSystemPrompt(ctx);
    expect(p).toContain('main');
    expect(p).toContain('abc1234');
    expect(p).toContain('uncommitted changes present');
  });

  it('includes the repository overview so absent file types are not searched', () => {
    expect(buildSystemPrompt(ctx)).toContain('Top level: backend (60)');
  });

  it('carries the rule against evaluative modifiers', () => {
    expect(buildSystemPrompt(ctx)).toContain('emotional or evaluative modifiers');
  });

  it('omits the dirty marker when there are no uncommitted changes', () => {
    expect(buildSystemPrompt({ ...ctx, repoDirty: false })).not.toContain('uncommitted changes');
  });

  it('tells the model not to use Markdown syntax Slack cannot render', () => {
    const p = buildSystemPrompt(ctx);
    expect(p).toContain('**bold**');
    expect(p).toContain('single asterisk');
    expect(p).toContain('Markdown tables');
  });

  it('directs structure through bullets, numbering, and blank lines', () => {
    const p = buildSystemPrompt(ctx);
    expect(p).toContain('bullets, numbering, and blank lines');
  });

  it('forbids process narration before the answer', () => {
    const p = buildSystemPrompt(ctx);
    expect(p).toContain('Do not narrate your process');
    expect(p).toContain('the conclusion itself');
  });
});
