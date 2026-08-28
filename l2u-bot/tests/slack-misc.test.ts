import { describe, it, expect } from 'vitest';
import { stripBotMention } from '../src/slack/gateway.js';

describe('stripBotMention', () => {
  it('strips the leading mention', () => {
    expect(stripBotMention('<@U0BOT> review PR 123')).toBe('review PR 123');
  });

  it('strips only the bot mention and keeps other mentions in the body', () => {
    // A trailing mention is the subject of the question; removing it loses the meaning.
    expect(stripBotMention('<@U0BOT> <@U111> please ask them')).toBe('<@U111> please ask them');
  });

  it('leaves text without a mention unchanged', () => {
    expect(stripBotMention('just a question')).toBe('just a question');
  });
});
