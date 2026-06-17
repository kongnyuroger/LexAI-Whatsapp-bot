import { Test, TestingModule } from '@nestjs/testing';
import { AxiosError, AxiosResponse } from 'axios';
import { ConversationState } from '@prisma/client';
import { DocumentChatService } from './document-chat.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { LexaiBackendService } from '../lexai-backend/lexai-backend.service';
import { ConversationService } from '../conversation/conversation.service';

function axiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as never,
  };
}

describe('DocumentChatService', () => {
  let service: DocumentChatService;
  let whatsappApiService: { sendTextMessage: jest.Mock };
  let lexaiBackendService: { sendChatMessage: jest.Mock };
  let conversationService: {
    ensureLinkedBackendUser: jest.Mock;
    transitionState: jest.Mock;
  };

  const user = {
    id: 'u1',
    phoneNumber: '+237600000000',
    lexaiAccessToken: 'token-abc',
  };
  const conversation = {
    id: 'c1',
    state: ConversationState.ANALYZED,
    activeDocumentId: 'doc-1',
  };

  beforeEach(async () => {
    whatsappApiService = { sendTextMessage: jest.fn() };
    lexaiBackendService = { sendChatMessage: jest.fn() };
    conversationService = {
      ensureLinkedBackendUser: jest.fn().mockResolvedValue(user),
      transitionState: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentChatService,
        { provide: WhatsappApiService, useValue: whatsappApiService },
        { provide: LexaiBackendService, useValue: lexaiBackendService },
        { provide: ConversationService, useValue: conversationService },
      ],
    }).compile();

    service = module.get<DocumentChatService>(DocumentChatService);
  });

  it('forwards the question to lexai-backend, transitions to CHATTING, and relays the answer', async () => {
    lexaiBackendService.sendChatMessage.mockResolvedValueOnce({
      id: 'msg-1',
      role: 'assistant',
      content: 'The notice period is 30 days.',
      createdAt: '2026-06-17T12:00:00.000Z',
    });

    await service.handleIncomingMessage(user as never, conversation as never, {
      from: user.phoneNumber,
      messageId: 'wamid.1',
      type: 'text',
      timestamp: '123',
      text: { body: 'What is the notice period?' },
    });

    expect(lexaiBackendService.sendChatMessage).toHaveBeenCalledWith(
      'token-abc',
      'doc-1',
      'What is the notice period?',
    );
    expect(conversationService.transitionState).toHaveBeenCalledWith(
      'c1',
      ConversationState.CHATTING,
    );
    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      'The notice period is 30 days.',
    );
  });

  it('splits a long answer into multiple WhatsApp messages', async () => {
    const longAnswer = Array.from(
      { length: 200 },
      (_, i) => `sentence ${i}.`,
    ).join(' ');
    lexaiBackendService.sendChatMessage.mockResolvedValueOnce({
      id: 'msg-1',
      role: 'assistant',
      content: longAnswer,
      createdAt: '2026-06-17T12:00:00.000Z',
    });

    await service.handleIncomingMessage(user as never, conversation as never, {
      from: user.phoneNumber,
      messageId: 'wamid.2',
      type: 'text',
      timestamp: '123',
      text: { body: 'Explain everything in detail.' },
    });

    expect(
      whatsappApiService.sendTextMessage.mock.calls.length,
    ).toBeGreaterThan(1);
  });

  it('asks for a text message when the incoming message has no text body', async () => {
    await service.handleIncomingMessage(user as never, conversation as never, {
      from: user.phoneNumber,
      messageId: 'wamid.3',
      type: 'sticker',
      timestamp: '123',
    });

    expect(lexaiBackendService.sendChatMessage).not.toHaveBeenCalled();
    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      expect.stringContaining('text message'),
    );
  });

  it('resets to IDLE with a friendly message when activeDocumentId is missing', async () => {
    await service.handleIncomingMessage(
      user as never,
      { ...conversation, activeDocumentId: null } as never,
      {
        from: user.phoneNumber,
        messageId: 'wamid.4',
        type: 'text',
        timestamp: '123',
        text: { body: 'hello?' },
      },
    );

    expect(lexaiBackendService.sendChatMessage).not.toHaveBeenCalled();
    expect(conversationService.transitionState).toHaveBeenCalledWith(
      'c1',
      ConversationState.IDLE,
    );
    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      expect.stringContaining('lost track'),
    );
  });

  it('resets to IDLE with a friendly message on 404 (document no longer found)', async () => {
    const error = new AxiosError('Not Found');
    error.response = axiosResponse({ message: 'Document not found' });
    (error.response as AxiosResponse).status = 404;
    lexaiBackendService.sendChatMessage.mockRejectedValueOnce(error);

    await service.handleIncomingMessage(user as never, conversation as never, {
      from: user.phoneNumber,
      messageId: 'wamid.5',
      type: 'text',
      timestamp: '123',
      text: { body: 'hello?' },
    });

    expect(conversationService.transitionState).toHaveBeenCalledWith(
      'c1',
      ConversationState.IDLE,
    );
    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      expect.stringContaining("couldn't find that document"),
    );
  });

  it('resets to IDLE with a friendly message on 422 (text not extracted)', async () => {
    const error = new AxiosError('Unprocessable Entity');
    error.response = axiosResponse({ message: 'text not extracted' });
    (error.response as AxiosResponse).status = 422;
    lexaiBackendService.sendChatMessage.mockRejectedValueOnce(error);

    await service.handleIncomingMessage(user as never, conversation as never, {
      from: user.phoneNumber,
      messageId: 'wamid.6',
      type: 'text',
      timestamp: '123',
      text: { body: 'hello?' },
    });

    expect(conversationService.transitionState).toHaveBeenCalledWith(
      'c1',
      ConversationState.IDLE,
    );
  });

  it('rethrows unexpected errors so BullMQ retries instead of giving up immediately', async () => {
    const error = new AxiosError('Service Unavailable');
    error.response = axiosResponse({});
    (error.response as AxiosResponse).status = 503;
    lexaiBackendService.sendChatMessage.mockRejectedValueOnce(error);

    await expect(
      service.handleIncomingMessage(user as never, conversation as never, {
        from: user.phoneNumber,
        messageId: 'wamid.7',
        type: 'text',
        timestamp: '123',
        text: { body: 'hello?' },
      }),
    ).rejects.toThrow('Service Unavailable');

    expect(conversationService.transitionState).not.toHaveBeenCalled();
  });
});
