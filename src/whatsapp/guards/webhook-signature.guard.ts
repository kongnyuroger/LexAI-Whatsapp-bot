import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import type { Request } from 'express';
import { timingSafeEqualStrings } from '../../common/timing-safe-equal.util';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';

// Verifies Meta signed this request, confirmed against Meta's webhook docs
// (June 2026): every Cloud API webhook POST carries
// `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw request body,
// keyed with the Meta App Secret>`. Without this, anyone who discovers the
// webhook URL could POST fabricated messages with arbitrary "from" numbers
// — there is no other authentication on this endpoint, since the
// hub.verify_token check only applies to the one-time GET handshake.
//
// Requires `rawBody: true` on the Nest app (see main.ts) — verifying against
// the parsed-and-re-serialized JSON body would not reliably reproduce the
// exact bytes Meta signed.
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<RawBodyRequest<Request>>();
    const appSecret = this.configService.get<string>('WHATSAPP_APP_SECRET');

    if (!appSecret) {
      this.logger.error(
        'WHATSAPP_APP_SECRET is not configured — rejecting all webhook deliveries',
      );
      throw new UnauthorizedException(
        'Webhook signature verification is not configured',
      );
    }

    const header = request.headers[SIGNATURE_HEADER];
    if (
      typeof header !== 'string' ||
      !header.startsWith(SIGNATURE_PREFIX) ||
      !request.rawBody
    ) {
      throw new UnauthorizedException('Missing or malformed webhook signature');
    }

    const expected = createHmac('sha256', appSecret)
      .update(request.rawBody)
      .digest('hex');
    const provided = header.slice(SIGNATURE_PREFIX.length);

    if (!timingSafeEqualStrings(provided, expected)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return true;
  }
}
