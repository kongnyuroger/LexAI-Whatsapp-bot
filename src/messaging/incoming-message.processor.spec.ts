import { Test, TestingModule } from '@nestjs/testing';
import { ConversationState } from '@prisma/client';
import { Job } from 'bullmq';
import { IncomingMessageProcessor } from './incoming-message.processor';
import { ConversationService } from '../conversation/conversation.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { DocumentIntakeService } from '../document-intake/document-intake.service';
import { DocumentChatService } from '../document-chat/document-chat.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { IncomingMessageJobData } from './incoming-message.types';

function makeJob(data: IncomingMessageJobData): Job<IncomingMessageJobData> {
  return { data, id: 'job-1', attemptsMade: 1 } as Job<IncomingMessageJobData>;
}

describe('IncomingMessageProcessor', () => {
  let processor: IncomingMessageProcessor;
  let conversationService: {
    getOrCreateForPhoneNumber: jest.Mock;
    transitionState: jest.Mock;
  };
  let whatsappApiService: { sendTextMessage: jest.Mock };
  let documentIntakeService: { handleIncomingDocument: jest.Mock };
  let documentChatService: { handleIncomingMessage: jest.Mock };

  beforeEach(async () => {
    conversationService = {
      getOrCreateForPhoneNumber: jest.fn(),
      transitionState: jest.fn(),
    };
    whatsappApiService = { sendTextMessage: jest.fn() };
    documentIntakeService = { handleIncomingDocument: jest.fn() };
    documentChatService = { handleIncomingMessage: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IncomingMessageProcessor,
        OnboardingService,
        { provide: ConversationService, useValue: conversationService },
        { provide: WhatsappApiService, useValue: whatsappApiService },
        { provide: DocumentIntakeService, useValue: documentIntakeService },
        { provide: DocumentChatService, useValue: documentChatService },
      ],
    }).compile();

    processor = module.get<IncomingMessageProcessor>(IncomingMessageProcessor);
  });

  function withConversationState(
    state: ConversationState,
    activeDocumentId: string | null = null,
  ) {
    conversationService.getOrCreateForPhoneNumber.mockResolvedValueOnce({
      user: { id: 'u1', phoneNumber: '237600000000' },
      conversation: { id: 'c1', state, activeDocumentId },
    });
  }

  it('delegates to DocumentIntakeService when a document arrives while IDLE', async () => {
    withConversationState(ConversationState.IDLE);
    const job = makeJob({
      from: '237600000000',
      messageId: 'wamid.1',
      type: 'document',
      timestamp: '123',
      document: { id: 'media-1', mime_type: 'application/pdf' },
    });

    await processor.process(job);

    expect(documentIntakeService.handleIncomingDocument).toHaveBeenCalledWith(
      { id: 'u1', phoneNumber: '237600000000' },
      { id: 'c1', state: ConversationState.IDLE, activeDocumentId: null },
      job.data,
    );
  });

  it('sends the welcome message and moves to AWAITING_DOCUMENT for ordinary text while IDLE', async () => {
    withConversationState(ConversationState.IDLE);

    await processor.process(
      makeJob({
        from: '237600000000',
        messageId: 'wamid.1b',
        type: 'text',
        timestamp: '123',
        text: { body: 'Hi' },
      }),
    );

    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      '237600000000',
      expect.stringContaining('photo or PDF'),
    );
    expect(conversationService.transitionState).toHaveBeenCalledWith(
      'c1',
      ConversationState.AWAITING_DOCUMENT,
    );
  });

  it('sends a reminder (no state change) for ordinary text while AWAITING_DOCUMENT', async () => {
    withConversationState(ConversationState.AWAITING_DOCUMENT);

    await processor.process(
      makeJob({
        from: '237600000000',
        messageId: 'wamid.1c',
        type: 'text',
        timestamp: '123',
        text: { body: 'ok' },
      }),
    );

    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      '237600000000',
      expect.stringContaining('Still waiting'),
    );
    expect(conversationService.transitionState).not.toHaveBeenCalled();
  });

  it('tells the user processing is still underway while PROCESSING', async () => {
    withConversationState(ConversationState.PROCESSING);

    await processor.process(
      makeJob({
        from: '237600000000',
        messageId: 'wamid.2',
        type: 'text',
        timestamp: '123',
        text: { body: 'Are you done yet?' },
      }),
    );

    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      '237600000000',
      expect.stringContaining('still working'),
    );
  });

  it('delegates free-form text while CHATTING to DocumentChatService', async () => {
    withConversationState(ConversationState.CHATTING);
    const job = makeJob({
      from: '237600000000',
      messageId: 'wamid.3',
      type: 'text',
      timestamp: '123',
      text: { body: 'What does clause 4 mean?' },
    });

    await processor.process(job);

    expect(documentChatService.handleIncomingMessage).toHaveBeenCalledWith(
      { id: 'u1', phoneNumber: '237600000000' },
      { id: 'c1', state: ConversationState.CHATTING, activeDocumentId: null },
      job.data,
    );
  });

  it('delegates a new document sent while ANALYZED to DocumentIntakeService (starts a new analysis)', async () => {
    withConversationState(ConversationState.ANALYZED);
    const job = makeJob({
      from: '237600000000',
      messageId: 'wamid.4',
      type: 'image',
      timestamp: '123',
      image: { id: 'media-2', mime_type: 'image/jpeg' },
    });

    await processor.process(job);

    expect(documentIntakeService.handleIncomingDocument).toHaveBeenCalledWith(
      { id: 'u1', phoneNumber: '237600000000' },
      {
        id: 'c1',
        state: ConversationState.ANALYZED,
        activeDocumentId: null,
      },
      job.data,
    );
  });

  describe('help command', () => {
    it.each([
      ConversationState.IDLE,
      ConversationState.AWAITING_DOCUMENT,
      ConversationState.PROCESSING,
      ConversationState.ANALYZED,
      ConversationState.CHATTING,
    ])(
      'sends the help message from %s without changing state',
      async (state) => {
        withConversationState(state);

        await processor.process(
          makeJob({
            from: '237600000000',
            messageId: 'wamid.help',
            type: 'text',
            timestamp: '123',
            text: { body: 'help' },
          }),
        );

        expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
          '237600000000',
          expect.stringContaining("Here's what I can do"),
        );
        expect(conversationService.transitionState).not.toHaveBeenCalled();
        expect(
          documentChatService.handleIncomingMessage,
        ).not.toHaveBeenCalled();
      },
    );
  });

  describe('restart command', () => {
    it('resets to IDLE and clears activeDocumentId when sent while CHATTING', async () => {
      withConversationState(ConversationState.CHATTING, 'doc-1');

      await processor.process(
        makeJob({
          from: '237600000000',
          messageId: 'wamid.restart',
          type: 'text',
          timestamp: '123',
          text: { body: 'restart' },
        }),
      );

      expect(conversationService.transitionState).toHaveBeenCalledWith(
        'c1',
        ConversationState.IDLE,
        { activeDocumentId: null },
      );
      expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
        '237600000000',
        expect.stringContaining('starting fresh'),
      );
      expect(documentChatService.handleIncomingMessage).not.toHaveBeenCalled();
    });

    it('does not call transitionState when already IDLE', async () => {
      withConversationState(ConversationState.IDLE);

      await processor.process(
        makeJob({
          from: '237600000000',
          messageId: 'wamid.restart2',
          type: 'text',
          timestamp: '123',
          text: { body: 'new' },
        }),
      );

      expect(conversationService.transitionState).not.toHaveBeenCalled();
      expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
        '237600000000',
        expect.stringContaining('starting fresh'),
      );
    });

    it('is ignored while PROCESSING (falls through to the busy message)', async () => {
      withConversationState(ConversationState.PROCESSING);

      await processor.process(
        makeJob({
          from: '237600000000',
          messageId: 'wamid.restart3',
          type: 'text',
          timestamp: '123',
          text: { body: 'cancel' },
        }),
      );

      expect(conversationService.transitionState).not.toHaveBeenCalled();
      expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
        '237600000000',
        expect.stringContaining('still working'),
      );
    });
  });

  describe('onFailed', () => {
    it('logs job failure context without throwing', () => {
      const job = makeJob({
        from: '237600000000',
        messageId: 'wamid.5',
        type: 'text',
        timestamp: '123',
      });

      expect(() => processor.onFailed(job, new Error('boom'))).not.toThrow();
    });
  });
});
