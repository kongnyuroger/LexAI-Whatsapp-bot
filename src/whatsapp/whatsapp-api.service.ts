import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

// Graph API version confirmed current as of June 2026 against Meta's
// official docs (https://developers.facebook.com/docs/graph-api/guides/versioning).
// Versions are supported for ~2 years after release; bump this when Meta
// deprecates it.
const GRAPH_API_VERSION = 'v25.0';
const GRAPH_API_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

interface MediaUrlResponse {
  messaging_product: string;
  url: string;
  mime_type: string;
  sha256: string;
  file_size: number;
  id: string;
}

interface SendMessageResponse {
  messaging_product: string;
  contacts: { input: string; wa_id: string }[];
  messages: { id: string; message_status?: string }[];
}

interface TemplateComponent {
  type: string;
  parameters: Record<string, unknown>[];
}

@Injectable()
export class WhatsappApiService {
  private readonly logger = new Logger(WhatsappApiService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  private get accessToken(): string {
    return this.configService.get<string>('WHATSAPP_ACCESS_TOKEN', '');
  }

  private get phoneNumberId(): string {
    return this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID', '');
  }

  private get authHeaders() {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  /** Resolves a media id from an incoming webhook message to a short-lived download URL. */
  async getMediaUrl(mediaId: string): Promise<string> {
    const response = await this.request<MediaUrlResponse>(() =>
      this.httpService.get(`${GRAPH_API_BASE_URL}/${mediaId}`, {
        headers: this.authHeaders,
      }),
    );
    return response.url;
  }

  /** Downloads the actual file bytes from a media URL obtained via getMediaUrl. The URL expires after 5 minutes. */
  async downloadMedia(mediaUrl: string): Promise<Buffer> {
    const response = await this.request<ArrayBuffer>(() =>
      this.httpService.get(mediaUrl, {
        headers: this.authHeaders,
        responseType: 'arraybuffer',
      }),
    );
    return Buffer.from(response);
  }

  /** Sends a free-form text message. Only deliverable within 24h of the user's last message (see sendTemplateMessage). */
  async sendTextMessage(to: string, body: string): Promise<void> {
    await this.request<SendMessageResponse>(() =>
      this.httpService.post(
        `${GRAPH_API_BASE_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body },
        },
        { headers: this.authHeaders },
      ),
    );
  }

  /**
   * Sends a pre-approved template message.
   *
   * WhatsApp's "24-hour customer service window" rule: a business can only send free-form
   * messages (sendTextMessage) within 24 hours of the user's last inbound message. Outside
   * that window, only pre-approved template messages (e.g. for first contact, or re-engaging
   * a stale conversation) can be sent. Templates must be created and approved in the Meta
   * Business Manager before they can be referenced here by name.
   */
  async sendTemplateMessage(
    to: string,
    templateName: string,
    languageCode: string,
    components?: TemplateComponent[],
  ): Promise<void> {
    await this.request<SendMessageResponse>(() =>
      this.httpService.post(
        `${GRAPH_API_BASE_URL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: templateName,
            language: { code: languageCode },
            ...(components ? { components } : {}),
          },
        },
        { headers: this.authHeaders },
      ),
    );
  }

  private async request<T>(
    fn: () => ReturnType<HttpService['get']>,
  ): Promise<T> {
    try {
      const response = await firstValueFrom(fn());
      return response.data as T;
    } catch (error) {
      const axiosError = error as AxiosError;
      this.logger.error(
        `WhatsApp Graph API request failed: ${axiosError.message}`,
        JSON.stringify(axiosError.response?.data ?? {}),
      );
      throw error;
    }
  }
}
