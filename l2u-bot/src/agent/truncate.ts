import { StringDecoder } from 'node:string_decoder';

export interface Truncated {
  readonly content: string;
  readonly truncated: boolean;
}

/**
 * Cut a tool result down to a byte budget.
 * The notice matters: without it the model assumes it saw everything and
 * draws conclusions from a partial view.
 */
export function truncate(text: string, maxBytes: number): Truncated {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return { content: text, truncated: false };
  }

  // StringDecoder keeps an incomplete UTF-8 sequence at the cut point in its
  // internal buffer, so no replacement characters (U+FFFD) leak into the output.
  const decoder = new StringDecoder('utf8');
  const head = decoder.write(buffer.subarray(0, maxBytes));

  const notice = `\n\n[Truncated at ${maxBytes} bytes. Showing part of ${buffer.byteLength} bytes total. Narrow the query if you need more.]`;
  return { content: head + notice, truncated: true };
}
