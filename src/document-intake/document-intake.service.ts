import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Conversation, ConversationState, WhatsappUser } from '@prisma/client';
import {
  MediaMetadata,
  WhatsappApiService,
} from '../whatsapp/whatsapp-api.service';
import { LexaiBackendService } from '../lexai-backend/lexai-backend.service';
import { ConversationService } from '../conversation/conversation.service';
import { IncomingMessageJobData } from '../messaging/incoming-message.types';
import { AnalyzeDocumentJobData } from './analyze-document.types';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
} from './document-intake.constants';
import {
  ANALYZE_DOCUMENT_JOB,
  DOCUMENT_ANALYSIS_QUEUE,
} from '../queue/queue.constants';

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
};

@Injectable()
export class DocumentIntakeService {
  private readonly logger = new Logger(DocumentIntakeService.name);

  constructor(
    private readonly whatsappApiService: WhatsappApiService,
    private readonly lexaiBackendService: LexaiBackendService,
    private readonly conversationService: ConversationService,
    @InjectQueue(DOCUMENT_ANALYSIS_QUEUE)
    private readonly analysisQueue: Queue<AnalyzeDocumentJobData>,
  ) {}

  async handleIncomingDocument(
    user: WhatsappUser,
    conversation: Conversation,
    message: IncomingMessageJobData,
  ): Promise<void> {
    const media = message.image ?? message.document;
    if (!media) {
      return;
    }

    if (!ALLOWED_MIME_TYPES.includes(media.mime_type)) {
      await this.whatsappApiService.sendTextMessage(
        user.phoneNumber,
        'Sorry, I can only read PDF, Word (.docx), or JPEG/PNG photos of contracts right now. Please resend in one of those formats.',
      );
      return;
    }

    let metadata: MediaMetadata;
    try {
      metadata = await this.whatsappApiService.getMediaMetadata(media.id);
    } catch (error) {
      this.logger.error(
        `Failed to fetch media metadata for ${media.id}: ${(error as Error).message}`,
      );
      await this.whatsappApiService.sendTextMessage(
        user.phoneNumber,
        "Sorry, I couldn't read that file. Please try sending it again.",
      );
      return;
    }

    if (metadata.fileSizeBytes > MAX_FILE_SIZE_BYTES) {
      const maxMb = Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024));
      await this.whatsappApiService.sendTextMessage(
        user.phoneNumber,
        `That file is too large for me to process right now (max ${maxMb}MB). Please send a smaller file or a clearer photo of just the document pages.`,
      );
      return;
    }

    try {
      const fileBuffer = await this.whatsappApiService.downloadMedia(
        metadata.url,
      );
      const linkedUser =
        await this.conversationService.ensureLinkedBackendUser(user);
      if (!linkedUser.lexaiAccessToken) {
        throw new Error(
          'ensureLinkedBackendUser resolved without a lexaiAccessToken',
        );
      }

      const filename = this.buildFilename(message, metadata.mimeType);
      const uploaded = await this.lexaiBackendService.uploadDocument(
        linkedUser.lexaiAccessToken,
        fileBuffer,
        filename,
        metadata.mimeType,
      );

      // lexai-backend extracts text synchronously as part of the upload
      // response itself (still HTTP 201) — a FAILED status here is not an
      // HTTP error, so it must be checked explicitly rather than assumed
      // successful just because the request didn't throw.
      if (uploaded.status === 'FAILED') {
        await this.whatsappApiService.sendTextMessage(
          user.phoneNumber,
          "Sorry, I couldn't read the text in that file. Please try a clearer photo or a different file.",
        );
        return;
      }

      await this.whatsappApiService.sendTextMessage(
        user.phoneNumber,
        'Got your document! Reading through it now — this usually takes under a minute.',
      );

      await this.conversationService.transitionState(
        conversation.id,
        ConversationState.PROCESSING,
        { activeDocumentId: uploaded.id },
      );

      await this.analysisQueue.add(ANALYZE_DOCUMENT_JOB, {
        documentId: uploaded.id,
        conversationId: conversation.id,
        whatsappUserId: user.id,
      });
    } catch (error) {
      this.logger.error(
        `Document intake failed for user=${user.id}: ${(error as Error).message}`,
      );
      await this.whatsappApiService.sendTextMessage(
        user.phoneNumber,
        'Sorry, something went wrong on our end while processing your document. Please try again in a moment.',
      );
    }
  }

  private buildFilename(
    message: IncomingMessageJobData,
    mimeType: string,
  ): string {
    if (message.document?.filename) {
      return message.document.filename;
    }
    const extension = EXTENSION_BY_MIME_TYPE[mimeType] ?? 'bin';
    return `document.${extension}`;
  }
}
