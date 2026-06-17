import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import FormData from 'form-data';

export type DocumentStatus = 'PROCESSING' | 'ANALYZED' | 'FAILED';

export interface UploadedDocument {
  id: string;
}

export interface DocumentRecord {
  id: string;
  status: DocumentStatus;
}

// Thin client for the lexai-backend document endpoints this bot bridges to.
// All document processing/analysis logic lives in lexai-backend; this only
// makes the HTTP calls (see README "Backend API Contract").
@Injectable()
export class LexaiBackendService {
  private readonly logger = new Logger(LexaiBackendService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  private get baseUrl(): string {
    return this.configService.get<string>('LEXAI_BACKEND_URL', '');
  }

  private authHeaders(accessToken: string) {
    return { Authorization: `Bearer ${accessToken}` };
  }

  async uploadDocument(
    accessToken: string,
    file: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<UploadedDocument> {
    const form = new FormData();
    form.append('file', file, { filename, contentType: mimeType });

    return this.request<UploadedDocument>(() =>
      this.httpService.post(`${this.baseUrl}/documents/upload`, form, {
        headers: { ...form.getHeaders(), ...this.authHeaders(accessToken) },
      }),
    );
  }

  async analyzeDocument(
    accessToken: string,
    documentId: string,
  ): Promise<void> {
    await this.request(() =>
      this.httpService.post(
        `${this.baseUrl}/documents/${documentId}/analyze`,
        {},
        { headers: this.authHeaders(accessToken) },
      ),
    );
  }

  async getDocument(
    accessToken: string,
    documentId: string,
  ): Promise<DocumentRecord> {
    return this.request<DocumentRecord>(() =>
      this.httpService.get(`${this.baseUrl}/documents/${documentId}`, {
        headers: this.authHeaders(accessToken),
      }),
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
        `lexai-backend request failed: ${axiosError.message}`,
        JSON.stringify(axiosError.response?.data ?? {}),
      );
      throw error;
    }
  }
}
