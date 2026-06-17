import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AxiosError } from 'axios';
import { ConversationState } from '@prisma/client';
import { ConversationService } from '../conversation/conversation.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import {
  AnalysisResult,
  LexaiBackendService,
} from '../lexai-backend/lexai-backend.service';
import { AnalysisFormatterService } from '../analysis-formatter/analysis-formatter.service';
import { AnalyzeDocumentJobData } from './analyze-document.types';
import { DOCUMENT_ANALYSIS_QUEUE } from '../queue/queue.constants';

// POST /documents/:id/analyze on lexai-backend is synchronous — it returns
// the full analysis or a definitive error (403/404/422) in one call, so
// there is no "still processing" status to poll for here. This job exists
// only to keep that (potentially slow, LLM-backed) call off the fast
// incoming-message queue.
@Processor(DOCUMENT_ANALYSIS_QUEUE)
export class AnalyzeDocumentProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyzeDocumentProcessor.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly whatsappApiService: WhatsappApiService,
    private readonly lexaiBackendService: LexaiBackendService,
    private readonly analysisFormatterService: AnalysisFormatterService,
  ) {
    super();
  }

  async process(job: Job<AnalyzeDocumentJobData>): Promise<void> {
    const { documentId, conversationId, whatsappUserId } = job.data;

    const user = await this.conversationService.findUserById(whatsappUserId);
    if (!user) {
      this.logger.error(
        `Cannot analyze document ${documentId}: WhatsApp user ${whatsappUserId} not found`,
      );
      return;
    }

    let analysis: AnalysisResult;
    try {
      // Re-checked here (not just at upload time) since the cached access
      // token may have expired in the time this job spent queued —
      // ensureLinkedBackendUser transparently refreshes or re-links as needed.
      const linkedUser =
        await this.conversationService.ensureLinkedBackendUser(user);
      analysis = await this.lexaiBackendService.analyzeDocument(
        linkedUser.lexaiAccessToken as string,
        documentId,
      );
    } catch (error) {
      const status = (error as AxiosError).response?.status;

      if (status === 403) {
        await this.givenUp(
          conversationId,
          user.phoneNumber,
          "You've reached your monthly document analysis limit on the free plan. Please try again next month.",
        );
        return;
      }
      if (status === 404 || status === 422) {
        await this.givenUp(
          conversationId,
          user.phoneNumber,
          "Sorry, I couldn't analyze that document. Please try sending it again.",
        );
        return;
      }
      // Anything else (network blip, 5xx) is rethrown so BullMQ retries per
      // the queue's attempts/backoff config; see onFailed for the case
      // where every retry is exhausted.
      throw error;
    }

    await this.conversationService.transitionState(
      conversationId,
      ConversationState.ANALYZED,
    );

    // Sent sequentially (not in parallel) so they arrive in the WhatsApp
    // thread in reading order: summary, then risk flags, then the closing
    // nudge + disclaimer.
    for (const message of this.analysisFormatterService.format(analysis)) {
      await this.whatsappApiService.sendTextMessage(user.phoneNumber, message);
    }
  }

  private async givenUp(
    conversationId: string,
    phoneNumber: string,
    message: string,
  ): Promise<void> {
    await this.conversationService.transitionState(
      conversationId,
      ConversationState.IDLE,
    );
    await this.whatsappApiService.sendTextMessage(phoneNumber, message);
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<AnalyzeDocumentJobData> | undefined,
    error: Error,
  ): Promise<void> {
    this.logger.error(
      `Job ${job?.id} (document ${job?.data?.documentId}) failed after ` +
        `${job?.attemptsMade ?? 0} attempt(s): ${error.message}`,
      error.stack,
    );

    if (!job) {
      return;
    }

    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return; // more retries scheduled — the user hasn't been told anything yet
    }

    const user = await this.conversationService.findUserById(
      job.data.whatsappUserId,
    );
    if (!user) {
      return;
    }

    await this.givenUp(
      job.data.conversationId,
      user.phoneNumber,
      'Sorry, something went wrong while analyzing your document. Please try sending it again.',
    );
  }
}
