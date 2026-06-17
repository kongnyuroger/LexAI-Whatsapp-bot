import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { ConversationState } from '@prisma/client';
import { ConversationService } from '../conversation/conversation.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { LexaiBackendService } from '../lexai-backend/lexai-backend.service';
import { AnalyzeDocumentJobData } from './analyze-document.types';
import {
  MAX_POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
} from './document-intake.constants';
import {
  DOCUMENT_ANALYSIS_QUEUE,
  POLL_ANALYSIS_JOB,
  TRIGGER_ANALYSIS_JOB,
} from '../queue/queue.constants';

@Processor(DOCUMENT_ANALYSIS_QUEUE)
export class AnalyzeDocumentProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyzeDocumentProcessor.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly whatsappApiService: WhatsappApiService,
    private readonly lexaiBackendService: LexaiBackendService,
    @InjectQueue(DOCUMENT_ANALYSIS_QUEUE)
    private readonly analysisQueue: Queue<AnalyzeDocumentJobData>,
  ) {
    super();
  }

  async process(job: Job<AnalyzeDocumentJobData>): Promise<void> {
    const { documentId, conversationId, whatsappUserId } = job.data;

    const user = await this.conversationService.findUserById(whatsappUserId);
    if (!user?.lexaiAccessToken) {
      this.logger.error(
        `Cannot analyze document ${documentId}: user ${whatsappUserId} has no lexai-backend token`,
      );
      return;
    }

    if (job.name === TRIGGER_ANALYSIS_JOB) {
      await this.lexaiBackendService.analyzeDocument(
        user.lexaiAccessToken,
        documentId,
      );
      await this.analysisQueue.add(
        POLL_ANALYSIS_JOB,
        { ...job.data, pollAttempt: 0 },
        { delay: POLL_INTERVAL_MS },
      );
      return;
    }

    // job.name === POLL_ANALYSIS_JOB
    const document = await this.lexaiBackendService.getDocument(
      user.lexaiAccessToken,
      documentId,
    );

    if (document.status === 'ANALYZED') {
      await this.conversationService.transitionState(
        conversationId,
        ConversationState.ANALYZED,
      );
      // TODO(Task 6): fetch GET /documents/:id/analysis and send the
      // formatted summary + risk flags instead of this placeholder.
      await this.whatsappApiService.sendTextMessage(
        user.phoneNumber,
        'Your document is ready! Ask me anything about it.',
      );
      return;
    }

    if (document.status === 'FAILED') {
      await this.conversationService.transitionState(
        conversationId,
        ConversationState.IDLE,
      );
      await this.whatsappApiService.sendTextMessage(
        user.phoneNumber,
        "Sorry, I couldn't analyze that document. Please try sending it again.",
      );
      return;
    }

    const nextAttempt = (job.data.pollAttempt ?? 0) + 1;
    if (nextAttempt >= MAX_POLL_ATTEMPTS) {
      await this.conversationService.transitionState(
        conversationId,
        ConversationState.IDLE,
      );
      await this.whatsappApiService.sendTextMessage(
        user.phoneNumber,
        'This is taking longer than expected. Please try sending your document again in a few minutes.',
      );
      return;
    }

    await this.analysisQueue.add(
      POLL_ANALYSIS_JOB,
      { ...job.data, pollAttempt: nextAttempt },
      { delay: POLL_INTERVAL_MS },
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<AnalyzeDocumentJobData> | undefined, error: Error) {
    this.logger.error(
      `Job ${job?.id} (${job?.name}, document ${job?.data?.documentId}) ` +
        `failed after ${job?.attemptsMade ?? 0} attempt(s): ${error.message}`,
      error.stack,
    );
  }
}
