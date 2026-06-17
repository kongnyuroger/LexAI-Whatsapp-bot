// What "a photo or PDF of a contract" (per the project brief) is allowed to
// be. Adjust to match whatever lexai-backend's /documents/upload actually
// accepts once that's confirmed.
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
];

// WhatsApp itself allows documents up to 100MB, but lexai-backend's OCR/LLM
// pipeline has no documented limit yet — 10MB is a conservative MVP default.
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const POLL_INTERVAL_MS = 5000;
// 24 polls * 5s = 2 minutes — a "generous timeout" per the task brief.
export const MAX_POLL_ATTEMPTS = 24;
