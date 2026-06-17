import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Throttle } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import { WebhookPayloadDto } from './dto/webhook-payload.dto';
import { WebhookSignatureGuard } from './guards/webhook-signature.guard';
import {
  INCOMING_MESSAGE_JOB,
  INCOMING_MESSAGE_QUEUE,
} from '../queue/queue.constants';
import { IncomingMessageJobData } from '../messaging/incoming-message.types';
import { timingSafeEqualStrings } from '../common/timing-safe-equal.util';

@Controller('webhook')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectQueue(INCOMING_MESSAGE_QUEUE)
    private readonly incomingMessageQueue: Queue<IncomingMessageJobData>,
  ) {}

  // Meta calls this once, when the webhook URL is configured in the Meta App
  // dashboard, to confirm this server controls the endpoint.
  // https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/
  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    const expectedToken = this.configService.get<string>(
      'WHATSAPP_VERIFY_TOKEN',
    );

    if (
      mode === 'subscribe' &&
      expectedToken &&
      timingSafeEqualStrings(token ?? '', expectedToken)
    ) {
      return challenge;
    }

    throw new ForbiddenException('Webhook verification failed');
  }

  // Real-time notification for every inbound message/status update. Meta
  // requires a fast 200 response or it will retry and eventually disable the
  // webhook, so the actual work (download media, call lexai-backend, reply)
  // happens in IncomingMessageProcessor, off the request path.
  //
  // WebhookSignatureGuard proves Meta sent this (X-Hub-Signature-256), since
  // there is no other authentication on this endpoint. The higher throttle
  // limit reflects Meta's webhook deliveries coming from a shared pool of
  // egress IPs serving many WhatsApp users — see app.module.ts.
  @UseGuards(WebhookSignatureGuard)
  @Throttle({ default: { limit: 1000, ttl: 60000 } })
  @Post()
  @HttpCode(200)
  async receiveWebhook(
    @Body() payload: WebhookPayloadDto,
  ): Promise<{ received: true }> {
    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        for (const message of change.value.messages ?? []) {
          this.logger.log(
            `Enqueuing message ${message.id} from=${message.from} type=${message.type}`,
          );
          await this.incomingMessageQueue.add(INCOMING_MESSAGE_JOB, {
            from: message.from,
            messageId: message.id,
            type: message.type,
            timestamp: message.timestamp,
            text: message.text,
            image: message.image,
            document: message.document,
          });
        }
      }
    }
    return { received: true };
  }
}
