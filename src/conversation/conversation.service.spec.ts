import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AxiosError, AxiosResponse } from 'axios';
import { ConversationState } from '@prisma/client';
import {
  ConversationService,
  InvalidStateTransitionError,
} from './conversation.service';
import { PrismaService } from '../prisma/prisma.service';

function axiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as never,
  };
}

describe('ConversationService', () => {
  let service: ConversationService;
  let prisma: {
    whatsappUser: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    conversation: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
  };
  let httpService: { post: jest.Mock };

  const config: Record<string, string> = {
    LEXAI_BACKEND_URL: 'http://backend.test',
    LEXAI_SERVICE_API_KEY: 'shared-secret',
  };

  beforeEach(async () => {
    prisma = {
      whatsappUser: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      conversation: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
    };
    httpService = { post: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: PrismaService, useValue: prisma },
        { provide: HttpService, useValue: httpService },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
      ],
    }).compile();

    service = module.get<ConversationService>(ConversationService);
  });

  describe('findOrCreateUser', () => {
    it('returns the existing user when the phone number is already known', async () => {
      const existing = { id: 'u1', phoneNumber: '+237600000000' };
      prisma.whatsappUser.findUnique.mockResolvedValueOnce(existing);

      const result = await service.findOrCreateUser('+237600000000');

      expect(result).toBe(existing);
      expect(prisma.whatsappUser.create).not.toHaveBeenCalled();
    });

    it('creates a new user when the phone number is unknown', async () => {
      prisma.whatsappUser.findUnique.mockResolvedValueOnce(null);
      const created = { id: 'u2', phoneNumber: '+237611111111' };
      prisma.whatsappUser.create.mockResolvedValueOnce(created);

      const result = await service.findOrCreateUser('+237611111111');

      expect(result).toBe(created);
      expect(prisma.whatsappUser.create).toHaveBeenCalledWith({
        data: { phoneNumber: '+237611111111' },
      });
    });
  });

  describe('findOrCreateConversation', () => {
    it('returns the existing conversation for a user', async () => {
      const existing = {
        id: 'c1',
        whatsappUserId: 'u1',
        state: ConversationState.IDLE,
      };
      prisma.conversation.findUnique.mockResolvedValueOnce(existing);

      const result = await service.findOrCreateConversation('u1');

      expect(result).toBe(existing);
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('creates a new IDLE conversation when none exists', async () => {
      prisma.conversation.findUnique.mockResolvedValueOnce(null);
      const created = {
        id: 'c2',
        whatsappUserId: 'u2',
        state: ConversationState.IDLE,
      };
      prisma.conversation.create.mockResolvedValueOnce(created);

      const result = await service.findOrCreateConversation('u2');

      expect(result).toBe(created);
      expect(prisma.conversation.create).toHaveBeenCalledWith({
        data: { whatsappUserId: 'u2', state: ConversationState.IDLE },
      });
    });
  });

  describe('transitionState', () => {
    it.each([
      [ConversationState.IDLE, ConversationState.PROCESSING],
      [ConversationState.PROCESSING, ConversationState.ANALYZED],
      [ConversationState.PROCESSING, ConversationState.IDLE],
      [ConversationState.ANALYZED, ConversationState.CHATTING],
      [ConversationState.CHATTING, ConversationState.PROCESSING],
      [ConversationState.CHATTING, ConversationState.IDLE],
    ])('allows %s -> %s', async (from, to) => {
      prisma.conversation.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'c1',
        state: from,
      });
      prisma.conversation.update.mockResolvedValueOnce({ id: 'c1', state: to });

      const result = await service.transitionState('c1', to);

      expect(result.state).toBe(to);
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { state: to },
      });
    });

    it.each([
      [ConversationState.IDLE, ConversationState.ANALYZED],
      [ConversationState.IDLE, ConversationState.CHATTING],
      [ConversationState.ANALYZED, ConversationState.AWAITING_DOCUMENT],
    ])('rejects %s -> %s', async (from, to) => {
      prisma.conversation.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'c1',
        state: from,
      });

      await expect(service.transitionState('c1', to)).rejects.toThrow(
        InvalidStateTransitionError,
      );
      expect(prisma.conversation.update).not.toHaveBeenCalled();
    });

    it('persists activeDocumentId alongside the state when provided', async () => {
      prisma.conversation.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'c1',
        state: ConversationState.IDLE,
      });
      prisma.conversation.update.mockResolvedValueOnce({
        id: 'c1',
        state: ConversationState.PROCESSING,
        activeDocumentId: 'doc-1',
      });

      await service.transitionState('c1', ConversationState.PROCESSING, {
        activeDocumentId: 'doc-1',
      });

      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: {
          state: ConversationState.PROCESSING,
          activeDocumentId: 'doc-1',
        },
      });
    });
  });

  describe('findUserById', () => {
    it('returns the user when found', async () => {
      const user = { id: 'u1', phoneNumber: '+237600000000' };
      prisma.whatsappUser.findUnique.mockResolvedValueOnce(user);

      const result = await service.findUserById('u1');

      expect(result).toBe(user);
      expect(prisma.whatsappUser.findUnique).toHaveBeenCalledWith({
        where: { id: 'u1' },
      });
    });

    it('returns null when not found', async () => {
      prisma.whatsappUser.findUnique.mockResolvedValueOnce(null);

      const result = await service.findUserById('missing');

      expect(result).toBeNull();
    });
  });

  describe('ensureLinkedBackendUser', () => {
    it('always calls whatsapp-link, even if a token is already cached (15min expiry)', async () => {
      const user = {
        id: 'u1',
        phoneNumber: '+237600000000',
        lexaiUserId: 'backend-1',
        lexaiAccessToken: 'stale-token',
      };
      httpService.post.mockReturnValueOnce(
        of(
          axiosResponse({
            accessToken: 'fresh-token',
            refreshToken: 'refresh-token',
            user: { id: 'backend-1' },
          }),
        ),
      );
      const updated = { ...user, lexaiAccessToken: 'fresh-token' };
      prisma.whatsappUser.update.mockResolvedValueOnce(updated);

      const result = await service.ensureLinkedBackendUser(user as never);

      expect(httpService.post).toHaveBeenCalledWith(
        'http://backend.test/auth/whatsapp-link',
        { phoneNumber: '+237600000000' },
        { headers: { 'X-Service-Key': 'shared-secret' } },
      );
      expect(result).toBe(updated);
    });

    it('calls the whatsapp-link endpoint and persists the returned token', async () => {
      const user = {
        id: 'u1',
        phoneNumber: '+237600000000',
        lexaiUserId: null,
        lexaiAccessToken: null,
      };
      httpService.post.mockReturnValueOnce(
        of(
          axiosResponse({
            accessToken: 'new-token',
            refreshToken: 'refresh-token',
            user: { id: 'backend-1' },
          }),
        ),
      );
      const updated = {
        ...user,
        lexaiUserId: 'backend-1',
        lexaiAccessToken: 'new-token',
      };
      prisma.whatsappUser.update.mockResolvedValueOnce(updated);

      const result = await service.ensureLinkedBackendUser(user as never);

      expect(httpService.post).toHaveBeenCalledWith(
        'http://backend.test/auth/whatsapp-link',
        { phoneNumber: '+237600000000' },
        { headers: { 'X-Service-Key': 'shared-secret' } },
      );
      expect(prisma.whatsappUser.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { lexaiUserId: 'backend-1', lexaiAccessToken: 'new-token' },
      });
      expect(result).toBe(updated);
    });

    it('propagates the error when the service API key is rejected', async () => {
      const user = {
        id: 'u1',
        phoneNumber: '+237600000000',
        lexaiUserId: null,
        lexaiAccessToken: null,
      };
      const error = new AxiosError('Unauthorized');
      error.response = axiosResponse({
        message: 'Invalid or missing service API key',
      });
      httpService.post.mockReturnValueOnce(throwError(() => error));

      await expect(
        service.ensureLinkedBackendUser(user as never),
      ).rejects.toThrow('Unauthorized');
      expect(prisma.whatsappUser.update).not.toHaveBeenCalled();
    });
  });
});
