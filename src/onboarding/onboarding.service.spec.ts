import { Test, TestingModule } from '@nestjs/testing';
import { OnboardingService } from './onboarding.service';

describe('OnboardingService', () => {
  let service: OnboardingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OnboardingService],
    }).compile();

    service = module.get<OnboardingService>(OnboardingService);
  });

  describe('parseCommand', () => {
    it.each(['help', 'Help', '  HELP  ', 'menu', '?'])(
      "recognizes '%s' as the help command",
      (text) => {
        expect(service.parseCommand(text)).toBe('help');
      },
    );

    it.each(['restart', 'New', ' reset ', 'cancel', 'Start Over'])(
      "recognizes '%s' as the restart command",
      (text) => {
        expect(service.parseCommand(text)).toBe('restart');
      },
    );

    it('returns null for ordinary text that happens to contain a keyword', () => {
      expect(
        service.parseCommand('Can you help me understand clause 4?'),
      ).toBeNull();
      expect(
        service.parseCommand('Is there a restart fee in this lease?'),
      ).toBeNull();
    });

    it('returns null for undefined or empty text', () => {
      expect(service.parseCommand(undefined)).toBeNull();
      expect(service.parseCommand('')).toBeNull();
    });
  });

  describe('message copy', () => {
    it('welcome message explains how to get started', () => {
      expect(service.getWelcomeMessage().toLowerCase()).toContain(
        'photo or pdf',
      );
    });

    it('awaiting-document reminder asks for a file', () => {
      expect(service.getAwaitingDocumentReminder().toLowerCase()).toContain(
        'document',
      );
    });

    it('help message lists supported formats', () => {
      expect(service.getHelpMessage()).toContain('PDF');
      expect(service.getHelpMessage()).toContain('10MB');
    });

    it('restart confirmation invites a new document', () => {
      expect(service.getRestartConfirmation().toLowerCase()).toContain('fresh');
    });
  });
});
