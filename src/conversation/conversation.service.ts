import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { Conversation, ConversationState, WhatsappUser } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Which next states are reachable from each current state. IDLE is reachable
// from everywhere since users can always send "new"/"restart" (Task 8) to
// reset mid-conversation.
const ALLOWED_TRANSITIONS: Record<ConversationState, ConversationState[]> = {
  IDLE: [ConversationState.AWAITING_DOCUMENT, ConversationState.PROCESSING],
  AWAITING_DOCUMENT: [ConversationState.PROCESSING, ConversationState.IDLE],
  PROCESSING: [ConversationState.ANALYZED, ConversationState.IDLE],
  ANALYZED: [
    ConversationState.CHATTING,
    ConversationState.PROCESSING,
    ConversationState.IDLE,
  ],
  CHATTING: [
    ConversationState.CHATTING,
    ConversationState.PROCESSING,
    ConversationState.IDLE,
  ],
};

interface WhatsappLinkResponse {
  userId: string;
  accessToken: string;
}

export class InvalidStateTransitionError extends Error {
  constructor(from: ConversationState, to: ConversationState) {
    super(`Invalid conversation state transition: ${from} -> ${to}`);
  }
}

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async findOrCreateUser(phoneNumber: string): Promise<WhatsappUser> {
    const existing = await this.prisma.whatsappUser.findUnique({
      where: { phoneNumber },
    });
    if (existing) {
      return existing;
    }
    return this.prisma.whatsappUser.create({ data: { phoneNumber } });
  }

  async findOrCreateConversation(
    whatsappUserId: string,
  ): Promise<Conversation> {
    const existing = await this.prisma.conversation.findUnique({
      where: { whatsappUserId },
    });
    if (existing) {
      return existing;
    }
    return this.prisma.conversation.create({
      data: { whatsappUserId, state: ConversationState.IDLE },
    });
  }

  async getOrCreateForPhoneNumber(
    phoneNumber: string,
  ): Promise<{ user: WhatsappUser; conversation: Conversation }> {
    const user = await this.findOrCreateUser(phoneNumber);
    const conversation = await this.findOrCreateConversation(user.id);
    return { user, conversation };
  }

  async transitionState(
    conversationId: string,
    nextState: ConversationState,
    data: Partial<{ activeDocumentId: string | null }> = {},
  ): Promise<Conversation> {
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });

    if (!ALLOWED_TRANSITIONS[conversation.state].includes(nextState)) {
      throw new InvalidStateTransitionError(conversation.state, nextState);
    }

    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { state: nextState, ...data },
    });
  }

  async findUserById(id: string): Promise<WhatsappUser | null> {
    return this.prisma.whatsappUser.findUnique({ where: { id } });
  }

  /**
   * Single seam for obtaining a usable lexai-backend access token for a WhatsApp-linked user.
   *
   * lexai-backend has no phone-number-based auth today (see README "Known Integration Gap").
   * This calls the proposed POST /auth/whatsapp-link endpoint and persists the returned token.
   * Until that endpoint exists in lexai-backend, this will fail — callers should treat the
   * rejection as "backend linking not available yet", not crash the whole message handler.
   */
  async ensureLinkedBackendUser(user: WhatsappUser): Promise<WhatsappUser> {
    if (user.lexaiAccessToken) {
      return user;
    }

    const backendUrl = this.configService.get<string>('LEXAI_BACKEND_URL');
    const linkSecret = this.configService.get<string>(
      'LEXAI_WHATSAPP_LINK_SECRET',
    );

    try {
      const response = await firstValueFrom(
        this.httpService.post<WhatsappLinkResponse>(
          `${backendUrl}/auth/whatsapp-link`,
          { phoneNumber: user.phoneNumber, secret: linkSecret },
        ),
      );

      return this.prisma.whatsappUser.update({
        where: { id: user.id },
        data: {
          lexaiUserId: response.data.userId,
          lexaiAccessToken: response.data.accessToken,
        },
      });
    } catch (error) {
      const axiosError = error as AxiosError;
      this.logger.error(
        `Failed to link WhatsApp user ${user.id} to lexai-backend ` +
          `(is POST /auth/whatsapp-link implemented yet?): ${axiosError.message}`,
      );
      throw error;
    }
  }
}
