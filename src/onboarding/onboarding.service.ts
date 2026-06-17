import { Injectable } from '@nestjs/common';
import { HELP_KEYWORDS, RESTART_KEYWORDS } from './onboarding.constants';

export type Command = 'help' | 'restart';

// Pure text/parsing helper for onboarding, help, and the "restart" escape
// hatch — no I/O of its own. IncomingMessageProcessor owns the actual state
// transitions and WhatsApp sends, same split as AnalysisFormatterService.
@Injectable()
export class OnboardingService {
  parseCommand(text: string | undefined): Command | null {
    if (!text) {
      return null;
    }
    const normalized = text.trim().toLowerCase();
    if (HELP_KEYWORDS.has(normalized)) {
      return 'help';
    }
    if (RESTART_KEYWORDS.has(normalized)) {
      return 'restart';
    }
    return null;
  }

  getWelcomeMessage(): string {
    return [
      "👋 Hi! I'm LexAI, your AI legal document assistant.",
      '',
      "Send me a photo or PDF of a contract and I'll summarize it in plain language and flag anything risky.",
      '',
      "Type 'help' anytime to see what I can do.",
    ].join('\n');
  }

  getAwaitingDocumentReminder(): string {
    return "Still waiting for your document! 📄 Send a photo or PDF whenever you're ready, or type 'help' for more info.";
  }

  getHelpMessage(): string {
    return [
      "Here's what I can do:",
      '',
      "📄 Send a photo or PDF of a contract and I'll summarize it and flag any risky clauses.",
      "💬 Once I've analyzed a document, ask me questions about it right here.",
      "🔄 Type 'restart' anytime to start over with a new document.",
      '',
      'Supported formats: PDF, Word (.docx), JPEG/PNG photos, up to 10MB.',
    ].join('\n');
  }

  getRestartConfirmation(): string {
    return "Okay, starting fresh! Send me a photo or PDF of a contract whenever you're ready.";
  }
}
