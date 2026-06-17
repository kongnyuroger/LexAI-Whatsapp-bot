// Hard limit for WhatsApp Cloud API free-form session text messages,
// confirmed June 2026 against Meta's docs (template messages are capped
// much lower, at 1024 — not relevant here since this bot only sends
// free-form text within the 24h customer service window).
export const WHATSAPP_MAX_MESSAGE_LENGTH = 4096;

// Practical chunk size this bot actually splits at — well under the hard
// limit, since a long wall of text is hard to read on a phone screen.
// Used both for formatted analysis results and document chat replies.
export const SAFE_MESSAGE_LENGTH = 1500;

// Splits text into WhatsApp-sized chunks, preferring line boundaries and
// falling back to word-wrapping any single line that alone exceeds
// maxLength (e.g. an unusually long paragraph with no line breaks).
export function splitWhatsappMessage(
  text: string,
  maxLength: number = SAFE_MESSAGE_LENGTH,
): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let current = '';

  for (const rawLine of text.split('\n')) {
    for (const line of wrapLongLine(rawLine, maxLength)) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length > maxLength && current) {
        chunks.push(current);
        current = line;
      } else {
        current = candidate;
      }
    }
  }
  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function wrapLongLine(line: string, maxLength: number): string[] {
  if (line.length <= maxLength) {
    return [line];
  }

  const wrapped: string[] = [];
  let current = '';
  for (const word of line.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxLength && current) {
      wrapped.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) {
    wrapped.push(current);
  }

  return wrapped;
}
