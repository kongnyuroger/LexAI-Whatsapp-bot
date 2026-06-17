// Hard limit for WhatsApp Cloud API free-form session text messages,
// confirmed June 2026 against Meta's docs (template messages are capped
// much lower, at 1024 — not relevant here since this bot only sends
// free-form text within the 24h customer service window).
export const WHATSAPP_MAX_MESSAGE_LENGTH = 4096;

// Practical chunk size this bot actually splits at — well under the hard
// limit, since a long wall of text is hard to read on a phone screen.
export const SAFE_MESSAGE_LENGTH = 1500;

export const SEVERITY_ORDER = ['HIGH', 'MEDIUM', 'LOW'] as const;

// Email/SMS equivalent of the web app's colored risk Badge component —
// WhatsApp has no rich UI, so emoji are the scannability substitute.
export const SEVERITY_EMOJI: Record<string, string> = {
  HIGH: '🔴',
  MEDIUM: '🟠',
  LOW: '🟢',
};

export const SEVERITY_LABEL: Record<string, string> = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};
