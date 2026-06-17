import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { WebhookSignatureGuard } from './webhook-signature.guard';

const APP_SECRET = 'test-app-secret';

function sign(rawBody: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function makeContext(headers: Record<string, string>, rawBody?: Buffer) {
  const request = { headers, rawBody };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('WebhookSignatureGuard', () => {
  let guard: WebhookSignatureGuard;
  let configService: { get: jest.Mock };

  beforeEach(() => {
    configService = { get: jest.fn().mockReturnValue(APP_SECRET) };
    guard = new WebhookSignatureGuard(
      configService as unknown as ConfigService,
    );
  });

  it('allows a request with a correctly-signed raw body', () => {
    const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');
    const context = makeContext(
      { 'x-hub-signature-256': sign(rawBody.toString()) },
      rawBody,
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a request with no signature header', () => {
    const rawBody = Buffer.from('{}');
    const context = makeContext({}, rawBody);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a request with a malformed signature header (missing sha256= prefix)', () => {
    const rawBody = Buffer.from('{}');
    const context = makeContext(
      { 'x-hub-signature-256': 'not-a-real-signature' },
      rawBody,
    );

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a request with an incorrect signature', () => {
    const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');
    const context = makeContext(
      { 'x-hub-signature-256': sign('{"tampered":true}') },
      rawBody,
    );

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects when WHATSAPP_APP_SECRET is not configured', () => {
    configService.get.mockReturnValue(undefined);
    const rawBody = Buffer.from('{}');
    const context = makeContext(
      { 'x-hub-signature-256': sign('{}', 'irrelevant') },
      rawBody,
    );

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
