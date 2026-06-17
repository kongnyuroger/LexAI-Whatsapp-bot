import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AxiosError, AxiosResponse } from 'axios';
import { WhatsappApiService } from './whatsapp-api.service';

function axiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as never,
  };
}

describe('WhatsappApiService', () => {
  let service: WhatsappApiService;
  let httpService: { get: jest.Mock; post: jest.Mock };

  const config: Record<string, string> = {
    WHATSAPP_ACCESS_TOKEN: 'test-token',
    WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  };

  beforeEach(async () => {
    httpService = { get: jest.fn(), post: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappApiService,
        { provide: HttpService, useValue: httpService },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
      ],
    }).compile();

    service = module.get<WhatsappApiService>(WhatsappApiService);
  });

  describe('getMediaMetadata', () => {
    it('returns the download url, mime type, and file size', async () => {
      httpService.get.mockReturnValueOnce(
        of(
          axiosResponse({
            messaging_product: 'whatsapp',
            url: 'https://lookaside.fbsbx.com/media/abc',
            mime_type: 'application/pdf',
            sha256: 'deadbeef',
            file_size: 204800,
            id: 'media-123',
          }),
        ),
      );

      const metadata = await service.getMediaMetadata('media-123');

      expect(metadata).toEqual({
        url: 'https://lookaside.fbsbx.com/media/abc',
        mimeType: 'application/pdf',
        fileSizeBytes: 204800,
      });
    });
  });

  describe('getMediaUrl', () => {
    it('requests the media metadata and returns the download url', async () => {
      httpService.get.mockReturnValueOnce(
        of(
          axiosResponse({
            messaging_product: 'whatsapp',
            url: 'https://lookaside.fbsbx.com/media/abc',
            mime_type: 'image/jpeg',
            sha256: 'deadbeef',
            file_size: 1024,
            id: 'media-123',
          }),
        ),
      );

      const url = await service.getMediaUrl('media-123');

      expect(url).toBe('https://lookaside.fbsbx.com/media/abc');
      expect(httpService.get).toHaveBeenCalledWith(
        'https://graph.facebook.com/v25.0/media-123',
        { headers: { Authorization: 'Bearer test-token' } },
      );
    });
  });

  describe('downloadMedia', () => {
    it('downloads bytes and returns a Buffer', async () => {
      const bytes = new TextEncoder().encode('file-contents').buffer;
      httpService.get.mockReturnValueOnce(of(axiosResponse(bytes)));

      const buffer = await service.downloadMedia(
        'https://lookaside.fbsbx.com/media/abc',
      );

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.toString()).toBe('file-contents');
      expect(httpService.get).toHaveBeenCalledWith(
        'https://lookaside.fbsbx.com/media/abc',
        {
          headers: { Authorization: 'Bearer test-token' },
          responseType: 'arraybuffer',
        },
      );
    });
  });

  describe('sendTextMessage', () => {
    it('posts a text message to the phone number messages endpoint', async () => {
      httpService.post.mockReturnValueOnce(
        of(
          axiosResponse({
            messaging_product: 'whatsapp',
            contacts: [{ input: '+237600000000', wa_id: '237600000000' }],
            messages: [{ id: 'wamid.abc' }],
          }),
        ),
      );

      await service.sendTextMessage('+237600000000', 'Hello there');

      expect(httpService.post).toHaveBeenCalledWith(
        'https://graph.facebook.com/v25.0/1234567890/messages',
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '+237600000000',
          type: 'text',
          text: { preview_url: false, body: 'Hello there' },
        },
        { headers: { Authorization: 'Bearer test-token' } },
      );
    });

    it('propagates errors from the Graph API', async () => {
      const error = new AxiosError('Request failed');
      error.response = axiosResponse({ error: { message: 'Invalid token' } });
      httpService.post.mockReturnValueOnce(throwError(() => error));

      await expect(
        service.sendTextMessage('+237600000000', 'Hello'),
      ).rejects.toThrow('Request failed');
    });
  });

  describe('sendTemplateMessage', () => {
    it('posts a template message with the given name and language', async () => {
      httpService.post.mockReturnValueOnce(
        of(
          axiosResponse({
            messaging_product: 'whatsapp',
            contacts: [{ input: '+237600000000', wa_id: '237600000000' }],
            messages: [{ id: 'wamid.def' }],
          }),
        ),
      );

      await service.sendTemplateMessage(
        '+237600000000',
        'welcome_message',
        'en_US',
      );

      expect(httpService.post).toHaveBeenCalledWith(
        'https://graph.facebook.com/v25.0/1234567890/messages',
        {
          messaging_product: 'whatsapp',
          to: '+237600000000',
          type: 'template',
          template: {
            name: 'welcome_message',
            language: { code: 'en_US' },
          },
        },
        { headers: { Authorization: 'Bearer test-token' } },
      );
    });
  });
});
