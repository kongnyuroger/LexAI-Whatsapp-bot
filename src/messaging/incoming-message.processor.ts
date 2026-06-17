import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ConversationState } from '@prisma/client';
import { ConversationService } from '../conversation/conversation.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { DocumentIntakeService } from '../document-intake/document-intake.service';
import { DocumentChatService } from '../document-chat/document-chat.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { INCOMING_MESSAGE_QUEUE } from '../queue/queue.constants';
import { IncomingMessageJobData } from './incoming-message.types';

const MEDIA_TYPES = new Set(['image', 'document']);

@Processor(INCOMING_MESSAGE_QUEUE)
export class IncomingMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(IncomingMessageProcessor.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly whatsappApiService: WhatsappApiService,
    private readonly documentIntakeService: DocumentIntakeService,
    private readonly documentChatService: DocumentChatService,
    private readonly onboardingService: OnboardingService,
  ) {
    super();
  }

  async process(job: Job<IncomingMessageJobData>): Promise<void> {
    const { from, type, messageId, text } = job.data;
    this.logger.log(
      `Processing message ${messageId} from=${from} type=${type}`,
    );

    const { user, conversation } =
      await this.conversationService.getOrCreateForPhoneNumber(from);
    const isMedia = MEDIA_TYPES.has(type);
    const command = this.onboardingService.parseCommand(text?.body);

    if (command === 'help') {
      await this.whatsappApiService.sendTextMessage(
        from,
        this.onboardingService.getHelpMessage(),
      );
      return;
    }

    // Not honored mid-PROCESSING: a job is already in flight, and changing
    // state out from under it could leave AnalyzeDocumentProcessor unable to
    // transition once it completes. The PROCESSING branch below replies
    // explaining why instead.
    if (
      command === 'restart' &&
      conversation.state !== ConversationState.PROCESSING
    ) {
      if (conversation.state !== ConversationState.IDLE) {
        await this.conversationService.transitionState(
          conversation.id,
          ConversationState.IDLE,
          { activeDocumentId: null },
        );
      }
      await this.whatsappApiService.sendTextMessage(
        from,
        this.onboardingService.getRestartConfirmation(),
      );
      return;
    }

    switch (conversation.state) {
      case ConversationState.IDLE:
        if (isMedia) {
          await this.documentIntakeService.handleIncomingDocument(
            user,
            conversation,
            job.data,
          );
        } else {
          await this.whatsappApiService.sendTextMessage(
            from,
            this.onboardingService.getWelcomeMessage(),
          );
          await this.conversationService.transitionState(
            conversation.id,
            ConversationState.AWAITING_DOCUMENT,
          );
        }
        break;

      case ConversationState.AWAITING_DOCUMENT:
        if (isMedia) {
          await this.documentIntakeService.handleIncomingDocument(
            user,
            conversation,
            job.data,
          );
        } else {
          await this.whatsappApiService.sendTextMessage(
            from,
            this.onboardingService.getAwaitingDocumentReminder(),
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
          // Sending a new file while already analyzed/chatting is treated as
          // "analyze this instead" rather than asking for confirmation first
          // — both states already allow transitioning straight to PROCESSING.
          await this.documentIntakeService.handleIncomingDocument(
            user,
            conversation,
            job.data,
          );
        } else {
          await this.documentChatService.handleIncomingMessage(
            user,
            conversation,
            job.data,
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
