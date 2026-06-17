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
