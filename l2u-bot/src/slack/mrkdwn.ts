/**
 * Slack does not render standard Markdown. It uses its own "mrkdwn" dialect:
 * `*bold*` with one asterisk, no headings, no tables, and its own link syntax.
 * Models write standard Markdown by habit, so `**bold**`, `## Heading`, and
 * `[label](url)` show up verbatim in the channel.
 *
 * The prompt asks for Slack-native formatting; this is the safety net for when
 * the model reaches for Markdown anyway.
 */

const FENCE = '```';

/** Convert standard Markdown into Slack mrkdwn, leaving code blocks untouched. */
export function toSlackMrkdwn(text: string): string {
  // Split on fenced code blocks so their contents are never rewritten.
  return text
    .split(FENCE)
    .map((segment, index) => (index % 2 === 1 ? segment : convertSegment(segment)))
    .join(FENCE);
}

function convertSegment(segment: string): string {
  // Inline code spans are protected the same way as fenced blocks.
  return segment
    .split('`')
    .map((part, index) => (index % 2 === 1 ? part : convertPlain(part)))
    .join('`');
}

function convertPlain(text: string): string {
  return text
    // [label](url) -> <url|label>
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
    // **bold** -> *bold*  (also covers __bold__)
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/__([^_\n]+)__/g, '*$1*')
    // ATX headings -> bold line. Slack has no headings.
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    // Markdown list markers -> bullet character
    .replace(/^(\s*)[-*]\s+(?!\s)/gm, '$1• ')
    // Horizontal rules render as literal dashes; drop them.
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    // A table separator row is meaningless without table rendering.
    .replace(/^\s*\|?[\s:-]*\|[\s|:-]*$/gm, '');
}
