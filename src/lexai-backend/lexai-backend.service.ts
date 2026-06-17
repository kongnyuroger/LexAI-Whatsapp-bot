import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import FormData from 'form-data';

// Verified directly against the running lexai-backend instance
// (lexAI-server/src/documents) rather than assumed.
export type DocumentStatus =
  | 'UPLOADED'
  | 'PROCESSING'
  | 'TEXT_EXTRACTED'
  | 'ANALYZED'
  | 'FAILED';

export interface UploadedDocument {
  id: string;
  status: DocumentStatus;
}

export interface DocumentRecord {
  id: string;
  status: DocumentStatus;
}

export interface AnalysisSummary {
  purpose: string;
  mainParties: string[];
  importantDates: string[];
  moneyInvolved: string[];
  responsibilities: string[];
}

export interface RiskFlag {
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  clauseText: string;
  explanation: string;
}

export interface AnalysisResult {
  documentId: string;
  summary: AnalysisSummary;
  riskFlags: RiskFlag[];
}

// Thin client for the lexai-backend document endpoints this bot bridges to.
// All document processing/analysis logic lives in lexai-backend; this only
// makes the HTTP calls. Shapes below were confirmed against the running
// lexai-backend instance (lexAI-server), not assumed:
// - POST /documents/upload extracts text synchronously and returns the
//   document record directly (status is TEXT_EXTRACTED or FAILED on the
//   same 201 response — a FAILED status is not an HTTP error).
// - POST /documents/:id/analyze is also synchronous: it runs the AI
//   analysis inline and returns the full result, or throws 403 (monthly
//   limit reached), 404, or 422 (text not extracted yet). There is no
//   "processing" status to poll for on the analysis itself.
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
  ): Promise<AnalysisResult> {
    return this.request<AnalysisResult>(() =>
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
