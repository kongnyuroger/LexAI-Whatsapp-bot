import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ConversationState } from '@prisma/client';
import { ConversationService } from '../conversation/conversation.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { INCOMING_MESSAGE_QUEUE } from '../queue/queue.constants';
import { IncomingMessageJobData } from './incoming-message.types';

const MEDIA_TYPES = new Set(['image', 'document']);

@Processor(INCOMING_MESSAGE_QUEUE)
export class IncomingMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(IncomingMessageProcessor.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly whatsappApiService: WhatsappApiService,
  ) {
    super();
  }

  async process(job: Job<IncomingMessageJobData>): Promise<void> {
    const { from, type, messageId } = job.data;
    this.logger.log(
      `Processing message ${messageId} from=${from} type=${type}`,
    );

    const { conversation } =
      await this.conversationService.getOrCreateForPhoneNumber(from);
    const isMedia = MEDIA_TYPES.has(type);

    switch (conversation.state) {
      case ConversationState.IDLE:
      case ConversationState.AWAITING_DOCUMENT:
        if (isMedia) {
          // TODO(Task 5): download the media, upload it to lexai-backend,
          // trigger analysis, and transition IDLE/AWAITING_DOCUMENT -> PROCESSING.
          await this.whatsappApiService.sendTextMessage(
            from,
            'Got it, processing...',
          );
        } else {
          // TODO(Task 8): send the onboarding/help copy explaining how to use the bot.
          await this.whatsappApiService.sendTextMessage(
            from,
            'Got it, processing...',
          );
        }
        break;

      case ConversationState.PROCESSING:
        await this.whatsappApiService.sendTextMessage(
          from,
          "I'm still working on your previous document — I'll message you as soon as it's ready.",
        );
        break;

      case ConversationState.ANALYZED:
      case ConversationState.CHATTING:
        if (isMedia) {
          // TODO(Task 7): confirm whether the user wants to start a new analysis
          // or keep discussing the current document, instead of silently switching.
          await this.whatsappApiService.sendTextMessage(
            from,
            'Got it, processing...',
          );
        } else {
          // TODO(Task 7): forward the message to lexai-backend's document chat
          // endpoint using conversation.activeDocumentId and reply with the answer.
          await this.whatsappApiService.sendTextMessage(
            from,
            'Got it, processing...',
          );
        }
        break;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<IncomingMessageJobData> | undefined, error: Error) {
    this.logger.error(
      `Job ${job?.id} (message ${job?.data?.messageId} from=${job?.data?.from}) ` +
        `failed after ${job?.attemptsMade ?? 0} attempt(s): ${error.message}`,
      error.stack,
    );
  }
}
