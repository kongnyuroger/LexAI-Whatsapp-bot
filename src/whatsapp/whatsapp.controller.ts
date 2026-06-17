import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookPayloadDto } from './dto/webhook-payload.dto';

@Controller('webhook')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(private readonly configService: ConfigService) {}

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

    if (mode === 'subscribe' && token === expectedToken) {
      return challenge;
    }

    throw new ForbiddenException('Webhook verification failed');
  }

  // Real-time notification for every inbound message/status update. Meta
  // requires a fast 200 response or it will retry and eventually disable the
  // webhook; this handler currently only parses and logs (queueing for
  // background processing is added in Task 4).
  @Post()
  @HttpCode(200)
  receiveWebhook(@Body() payload: WebhookPayloadDto): { received: true } {
    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        for (const message of change.value.messages ?? []) {
          this.logger.log(
            `Incoming message from=${message.from} type=${message.type} ` +
              `content=${JSON.stringify(
                message.text ?? message.image ?? message.document ?? null,
              )}`,
          );
        }
      }
    }
    return { received: true };
  }
}
