import { describe, it, expect } from 'vitest';
import { toSlackMrkdwn } from '../src/slack/mrkdwn.js';

describe('toSlackMrkdwn', () => {
  it('converts double-asterisk bold to Slack single-asterisk bold', () => {
    expect(toSlackMrkdwn('this is **important** text')).toBe('this is *important* text');
  });

  it('converts underscore bold as well', () => {
    expect(toSlackMrkdwn('__strong__ point')).toBe('*strong* point');
  });

  it('turns headings into bold lines — Slack has no headings', () => {
    expect(toSlackMrkdwn('## Findings\nbody')).toBe('*Findings*\nbody');
    expect(toSlackMrkdwn('# Title')).toBe('*Title*');
  });

  it('converts Markdown links into Slack link syntax', () => {
    expect(toSlackMrkdwn('see [the docs](https://example.com/a)')).toBe(
      'see <https://example.com/a|the docs>',
    );
  });

  it('replaces list markers with a bullet character', () => {
    expect(toSlackMrkdwn('- first\n- second')).toBe('• first\n• second');
  });

  it('preserves indentation on nested lists', () => {
    expect(toSlackMrkdwn('- top\n  - nested')).toBe('• top\n  • nested');
  });

  it('leaves fenced code blocks completely untouched', () => {
    const input = 'before\n```\nconst a = **not bold**;\n# not a heading\n```\nafter';
    expect(toSlackMrkdwn(input)).toBe(input);
  });

  it('leaves inline code untouched', () => {
    expect(toSlackMrkdwn('call `foo(**args)` now')).toBe('call `foo(**args)` now');
  });

  it('converts text around a code block but not inside it', () => {
    const out = toSlackMrkdwn('**head**\n```\n**keep**\n```\n**tail**');
    expect(out).toBe('*head*\n```\n**keep**\n```\n*tail*');
  });

  it('drops horizontal rules', () => {
    expect(toSlackMrkdwn('a\n---\nb')).toBe('a\n\nb');
  });

  it('drops table separator rows', () => {
    const out = toSlackMrkdwn('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(out).toContain('| a | b |');
    expect(out).not.toContain('|---|');
  });

  it('does not mangle bold spanning an asterisk-free line', () => {
    expect(toSlackMrkdwn('normal text with no markup')).toBe('normal text with no markup');
  });

  it('leaves a file path with an underscore alone', () => {
    expect(toSlackMrkdwn('see src/my_file.ts:12')).toBe('see src/my_file.ts:12');
  });

  it('handles an unclosed code fence without throwing', () => {
    expect(() => toSlackMrkdwn('text\n```\nunclosed')).not.toThrow();
  });
});
