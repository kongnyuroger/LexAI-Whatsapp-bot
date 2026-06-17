import { Test, TestingModule } from '@nestjs/testing';
import { ConversationState } from '@prisma/client';
import { Job } from 'bullmq';
import { IncomingMessageProcessor } from './incoming-message.processor';
import { ConversationService } from '../conversation/conversation.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { IncomingMessageJobData } from './incoming-message.types';

function makeJob(data: IncomingMessageJobData): Job<IncomingMessageJobData> {
  return { data, id: 'job-1', attemptsMade: 1 } as Job<IncomingMessageJobData>;
}

describe('IncomingMessageProcessor', () => {
  let processor: IncomingMessageProcessor;
  let conversationService: { getOrCreateForPhoneNumber: jest.Mock };
  let whatsappApiService: { sendTextMessage: jest.Mock };

  beforeEach(async () => {
    conversationService = { getOrCreateForPhoneNumber: jest.fn() };
    whatsappApiService = { sendTextMessage: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IncomingMessageProcessor,
        { provide: ConversationService, useValue: conversationService },
        { provide: WhatsappApiService, useValue: whatsappApiService },
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

  it('replies with a placeholder when a document arrives while IDLE', async () => {
    withConversationState(ConversationState.IDLE);

    await processor.process(
      makeJob({
        from: '237600000000',
        messageId: 'wamid.1',
        type: 'document',
        timestamp: '123',
        document: { id: 'media-1', mime_type: 'application/pdf' },
      }),
    );

    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      '237600000000',
      'Got it, processing...',
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

  it('routes free-form text while CHATTING through the chat placeholder', async () => {
    withConversationState(ConversationState.CHATTING);

    await processor.process(
      makeJob({
        from: '237600000000',
        messageId: 'wamid.3',
        type: 'text',
        timestamp: '123',
        text: { body: 'What does clause 4 mean?' },
      }),
    );

    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      '237600000000',
      'Got it, processing...',
    );
  });

  it('routes a new document sent while ANALYZED through the placeholder', async () => {
    withConversationState(ConversationState.ANALYZED);

    await processor.process(
      makeJob({
        from: '237600000000',
        messageId: 'wamid.4',
        type: 'image',
        timestamp: '123',
        image: { id: 'media-2', mime_type: 'image/jpeg' },
      }),
    );

    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      '237600000000',
      'Got it, processing...',
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
