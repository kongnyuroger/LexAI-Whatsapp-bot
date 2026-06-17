import { Test, TestingModule } from '@nestjs/testing';
import { ConversationState } from '@prisma/client';
import { Job } from 'bullmq';
import { IncomingMessageProcessor } from './incoming-message.processor';
import { ConversationService } from '../conversation/conversation.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { DocumentIntakeService } from '../document-intake/document-intake.service';
import { DocumentChatService } from '../document-chat/document-chat.service';
import { IncomingMessageJobData } from './incoming-message.types';

function makeJob(data: IncomingMessageJobData): Job<IncomingMessageJobData> {
  return { data, id: 'job-1', attemptsMade: 1 } as Job<IncomingMessageJobData>;
}

describe('IncomingMessageProcessor', () => {
  let processor: IncomingMessageProcessor;
  let conversationService: { getOrCreateForPhoneNumber: jest.Mock };
  let whatsappApiService: { sendTextMessage: jest.Mock };
  let documentIntakeService: { handleIncomingDocument: jest.Mock };
  let documentChatService: { handleIncomingMessage: jest.Mock };

  beforeEach(async () => {
    conversationService = { getOrCreateForPhoneNumber: jest.fn() };
    whatsappApiService = { sendTextMessage: jest.fn() };
    documentIntakeService = { handleIncomingDocument: jest.fn() };
    documentChatService = { handleIncomingMessage: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IncomingMessageProcessor,
        { provide: ConversationService, useValue: conversationService },
        { provide: WhatsappApiService, useValue: whatsappApiService },
        { provide: DocumentIntakeService, useValue: documentIntakeService },
        { provide: DocumentChatService, useValue: documentChatService },
      ],
    }).compile();

    processor = module.get<IncomingMessageProcessor>(IncomingMessageProcessor);
  });

  function withConversationState(state: ConversationState) {
    conversationService.getOrCreateForPhoneNumber.mockResolvedValueOnce({
      user: { id: 'u1', phoneNumber: '237600000000' },
      conversation: { id: 'c1', state },
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
      { id: 'c1', state: ConversationState.IDLE },
      job.data,
    );
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
      { id: 'c1', state: ConversationState.CHATTING },
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
      { id: 'c1', state: ConversationState.ANALYZED },
      job.data,
    );
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
