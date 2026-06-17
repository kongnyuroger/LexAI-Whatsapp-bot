import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AxiosError, AxiosResponse } from 'axios';
import { LexaiBackendService } from './lexai-backend.service';

function axiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as never,
  };
}

describe('LexaiBackendService', () => {
  let service: LexaiBackendService;
  let httpService: { get: jest.Mock; post: jest.Mock };

  beforeEach(async () => {
    httpService = { get: jest.fn(), post: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LexaiBackendService,
        { provide: HttpService, useValue: httpService },
        {
          provide: ConfigService,
          useValue: { get: () => 'http://backend.test' },
        },
      ],
    }).compile();

    service = module.get<LexaiBackendService>(LexaiBackendService);
  });

  describe('uploadDocument', () => {
    it('posts a multipart form with the file and bearer token', async () => {
      httpService.post.mockReturnValueOnce(
        of(axiosResponse({ id: 'doc-1', status: 'TEXT_EXTRACTED' })),
      );

      const result = await service.uploadDocument(
        'token-abc',
        Buffer.from('file-bytes'),
        'contract.pdf',
        'application/pdf',
      );

      expect(result).toEqual({ id: 'doc-1', status: 'TEXT_EXTRACTED' });
      expect(httpService.post).toHaveBeenCalledTimes(1);
      const [url, form, options] = httpService.post.mock.calls[0] as [
        string,
        { getHeaders: () => Record<string, string> },
        { headers: Record<string, string> },
      ];
      expect(url).toBe('http://backend.test/documents/upload');
      expect(form.getHeaders).toBeInstanceOf(Function);
      expect(options.headers.Authorization).toBe('Bearer token-abc');
    });
  });

  describe('analyzeDocument', () => {
    it('runs analysis synchronously and returns the summary + risk flags', async () => {
      const analysis = {
        documentId: 'doc-1',
        summary: {
          purpose: 'Residential lease agreement',
          mainParties: ['Alice', 'Bob'],
          importantDates: ['2026-01-01'],
          moneyInvolved: ['$1200/month'],
          responsibilities: ['Tenant pays rent by the 1st'],
        },
        riskFlags: [
          {
            severity: 'HIGH',
            clauseText: 'Tenant waives all rights to dispute eviction.',
            explanation:
              'This clause may be unenforceable and is highly unfavorable.',
          },
        ],
      };
      httpService.post.mockReturnValueOnce(of(axiosResponse(analysis)));

      const result = await service.analyzeDocument('token-abc', 'doc-1');

      expect(result).toEqual(analysis);
      expect(httpService.post).toHaveBeenCalledWith(
        'http://backend.test/documents/doc-1/analyze',
        {},
        { headers: { Authorization: 'Bearer token-abc' } },
      );
    });

    it('propagates errors from the backend', async () => {
      const error = new AxiosError('Service Unavailable');
      error.response = axiosResponse({ message: 'down for maintenance' });
      httpService.post.mockReturnValueOnce(throwError(() => error));

      await expect(
        service.analyzeDocument('token-abc', 'doc-1'),
      ).rejects.toThrow('Service Unavailable');
    });
  });

  describe('getDocument', () => {
    it('returns the document status', async () => {
      httpService.get.mockReturnValueOnce(
        of(axiosResponse({ id: 'doc-1', status: 'ANALYZED' })),
      );

      const result = await service.getDocument('token-abc', 'doc-1');

      expect(result).toEqual({ id: 'doc-1', status: 'ANALYZED' });
      expect(httpService.get).toHaveBeenCalledWith(
        'http://backend.test/documents/doc-1',
        { headers: { Authorization: 'Bearer token-abc' } },
      );
    });
  });

  describe('sendChatMessage', () => {
    it('posts the question and returns the assistant message', async () => {
      const assistantMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: 'The notice period is 30 days.',
        createdAt: '2026-06-17T12:00:00.000Z',
      };
      httpService.post.mockReturnValueOnce(
        of(axiosResponse({ message: assistantMessage })),
      );

      const result = await service.sendChatMessage(
        'token-abc',
        'doc-1',
        'What is the notice period?',
      );

      expect(result).toEqual(assistantMessage);
      expect(httpService.post).toHaveBeenCalledWith(
        'http://backend.test/documents/doc-1/chat',
        { message: 'What is the notice period?' },
        { headers: { Authorization: 'Bearer token-abc' } },
      );
    });

    it('propagates errors from the backend (e.g. 404 document not found)', async () => {
      const error = new AxiosError('Not Found');
      error.response = axiosResponse({ message: 'Document not found' });
      httpService.post.mockReturnValueOnce(throwError(() => error));

      await expect(
        service.sendChatMessage('token-abc', 'doc-1', 'hello?'),
      ).rejects.toThrow('Not Found');
    });
  });
});
