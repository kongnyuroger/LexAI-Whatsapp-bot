import { Injectable, Logger } from '@nestjs/common';
import { AxiosError } from 'axios';
import { Conversation, ConversationState, WhatsappUser } from '@prisma/client';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { LexaiBackendService } from '../lexai-backend/lexai-backend.service';
import { ConversationService } from '../conversation/conversation.service';
import { IncomingMessageJobData } from '../messaging/incoming-message.types';
import { splitWhatsappMessage } from '../common/whatsapp-text.util';

// Forwards a text message from a user already in ANALYZED/CHATTING state to
// lexai-backend's document chat endpoint (POST /documents/:id/chat) and
// relays the assistant's answer back. Confirmed synchronous on
// lexai-backend's side (lexAI-server/src/chat) — it runs RAG-grounded Q&A
// inline and returns the answer or throws 404/422 in one call, same as
// analyze. No usage-limit guard applies to chat (unlike analyze).
@Injectable()
export class DocumentChatService {
  private readonly logger = new Logger(DocumentChatService.name);

  constructor(
    private readonly whatsappApiService: WhatsappApiService,
    private readonly lexaiBackendService: LexaiBackendService,
    private readonly conversationService: ConversationService,
  ) {}

  async handleIncomingMessage(
    user: WhatsappUser,
    conversation: Conversation,
    message: IncomingMessageJobData,
  ): Promise<void> {
    const question = message.text?.body;
    if (!question) {
      await this.whatsappApiService.sendTextMessage(
        user.phoneNumber,
        'Please send your question about the document as a text message.',
      );
      return;
    }

    if (!conversation.activeDocumentId) {
      this.logger.error(
        `Conversation ${conversation.id} is in ${conversation.state} with no activeDocumentId`,
      );
      await this.givenUp(
        conversation.id,
        user.phoneNumber,
        'Sorry, I lost track of which document we were discussing. Please send it again.',
      );
      return;
    }

    try {
      const linkedUser =
        await this.conversationService.ensureLinkedBackendUser(user);
      const answer = await this.lexaiBackendService.sendChatMessage(
        linkedUser.lexaiAccessToken as string,
        conversation.activeDocumentId,
        question,
      );

      await this.conversationService.transitionState(
        conversation.id,
        ConversationState.CHATTING,
      );

      for (const chunk of splitWhatsappMessage(answer.content)) {
        await this.whatsappApiService.sendTextMessage(user.phoneNumber, chunk);
      }
    } catch (error) {
      const status = (error as AxiosError).response?.status;

      if (status === 404 || status === 422) {
        await this.givenUp(
          conversation.id,
          user.phoneNumber,
          "Sorry, I couldn't find that document anymore. Please send it again to keep chatting about it.",
        );
        return;
      }
      // Anything else (network blip, 5xx) is rethrown so BullMQ retries per
      // the incoming-message queue's attempts/backoff config.
      throw error;
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
}
