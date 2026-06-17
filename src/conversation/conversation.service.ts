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
  accessToken: string;
  refreshToken: string;
  user: { id: string };
}

interface RefreshResponse {
  accessToken: string;
}

// lexai-backend issues access tokens with a 15-minute expiry (documented in
// its own README's "Service-to-Service / WhatsApp Integration" section and
// hardcoded as `expiresIn: '15m'` in its AuthService). Refresh a little
// early so a token never expires mid-request.
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 30 * 1000;

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
   * Mirrors the flow lexai-backend's own README documents for this bot ("Service-to-Service /
   * WhatsApp Integration" -> "Full flow"): link once via POST /auth/whatsapp-link, cache the
   * access + refresh token pair, reuse the cached access token while it's still valid, and use
   * POST /auth/refresh (not a fresh link) once it expires. Falls back to re-linking only if no
   * refresh token is cached yet or the refresh token itself has expired (its 7-day lifetime, vs
   * the access token's 15 minutes) — re-linking is documented as idempotent, so this is always a
   * safe recovery path.
   */
  async ensureLinkedBackendUser(user: WhatsappUser): Promise<WhatsappUser> {
    if (this.hasValidAccessToken(user)) {
      return user;
    }

    if (user.lexaiRefreshToken) {
      try {
        return await this.refreshAccessToken(user);
      } catch (error) {
        this.logger.warn(
          `Refresh token rejected for WhatsApp user ${user.id}, falling back to re-linking: ${(error as Error).message}`,
        );
      }
    }

    return this.linkBackendUser(user);
  }

  private hasValidAccessToken(user: WhatsappUser): boolean {
    if (!user.lexaiAccessToken || !user.lexaiAccessTokenExpiresAt) {
      return false;
    }
    return (
      user.lexaiAccessTokenExpiresAt.getTime() >
      Date.now() + TOKEN_EXPIRY_SAFETY_MARGIN_MS
    );
  }

  private async refreshAccessToken(user: WhatsappUser): Promise<WhatsappUser> {
    const backendUrl = this.configService.get<string>('LEXAI_BACKEND_URL');

    const response = await firstValueFrom(
      this.httpService.post<RefreshResponse>(`${backendUrl}/auth/refresh`, {
        refreshToken: user.lexaiRefreshToken,
      }),
    );

    return this.prisma.whatsappUser.update({
      where: { id: user.id },
      data: {
        lexaiAccessToken: response.data.accessToken,
        lexaiAccessTokenExpiresAt: this.computeAccessTokenExpiry(),
      },
    });
  }

  private async linkBackendUser(user: WhatsappUser): Promise<WhatsappUser> {
    const backendUrl = this.configService.get<string>('LEXAI_BACKEND_URL');
    const serviceApiKey = this.configService.get<string>(
      'LEXAI_SERVICE_API_KEY',
    );

    try {
      const response = await firstValueFrom(
        this.httpService.post<WhatsappLinkResponse>(
          `${backendUrl}/auth/whatsapp-link`,
          { phoneNumber: user.phoneNumber },
          { headers: { 'X-Service-Key': serviceApiKey } },
        ),
      );

      return this.prisma.whatsappUser.update({
        where: { id: user.id },
        data: {
          lexaiUserId: response.data.user.id,
          lexaiAccessToken: response.data.accessToken,
          lexaiRefreshToken: response.data.refreshToken,
          lexaiAccessTokenExpiresAt: this.computeAccessTokenExpiry(),
        },
      });
    } catch (error) {
      const axiosError = error as AxiosError;
      this.logger.error(
        `Failed to link WhatsApp user ${user.id} to lexai-backend: ${axiosError.message}`,
      );
      throw error;
    }
  }

  private computeAccessTokenExpiry(): Date {
    return new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  }
}
