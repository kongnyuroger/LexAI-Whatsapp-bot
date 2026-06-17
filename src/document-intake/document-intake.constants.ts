// Verified directly against lexai-backend's upload validator
// (lexAI-server/src/documents/documents.controller.ts) rather than assumed.
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
];

// Matches lexai-backend's own MAX_FILE_BYTES — confirmed, not a guess.
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
