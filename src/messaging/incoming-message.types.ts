export interface IncomingMessageJobData {
  from: string;
  messageId: string;
  type: string;
  timestamp: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256?: string };
  document?: {
    id: string;
    mime_type: string;
    filename?: string;
    sha256?: string;
  };
}
