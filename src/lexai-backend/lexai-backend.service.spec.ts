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
      httpService.post.mockReturnValueOnce(of(axiosResponse({ id: 'doc-1' })));

      const result = await service.uploadDocument(
        'token-abc',
        Buffer.from('file-bytes'),
        'contract.pdf',
        'application/pdf',
      );

      expect(result).toEqual({ id: 'doc-1' });
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
    it('triggers analysis for the given document id', async () => {
      httpService.post.mockReturnValueOnce(of(axiosResponse({})));

      await service.analyzeDocument('token-abc', 'doc-1');

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
});
