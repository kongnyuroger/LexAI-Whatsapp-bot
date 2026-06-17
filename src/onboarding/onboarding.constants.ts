// Exact-match keywords (case-insensitive, trimmed) rather than substring
// matching, so ordinary sentences that happen to contain these words (e.g.
// a chat question mentioning "restart of the lease term") aren't misread
// as commands.
export const HELP_KEYWORDS = new Set(['help', 'menu', '?']);
export const RESTART_KEYWORDS = new Set([
  'restart',
  'new',
  'reset',
  'cancel',
  'start over',
]);
