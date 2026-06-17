import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createHmac } from 'crypto';
import request from 'supertest';
import { AppModule } from './../src/app.module';

const APP_SECRET = 'test-app-secret';

function sign(rawBody: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
}

describe('Webhook (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /webhook (verification)', () => {
    it('echoes hub.challenge when the verify token matches', () => {
      return request(app.getHttpServer())
        .get('/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'test-verify-token',
          'hub.challenge': 'challenge-accepted-123',
        })
        .expect(200)
        .expect('challenge-accepted-123');
    });

    it('rejects when the verify token does not match', () => {
      return request(app.getHttpServer())
        .get('/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong-token',
          'hub.challenge': 'challenge-accepted-123',
        })
        .expect(403);
    });
  });

  describe('POST /webhook (incoming notification)', () => {
    const validPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550783881',
                  phone_number_id: '106540352242922',
                },
                contacts: [
                  { profile: { name: 'Test User' }, wa_id: '237600000000' },
                ],
                messages: [
                  {
                    from: '237600000000',
                    id: 'wamid.abc',
                    timestamp: '1749416383',
                    type: 'text',
                    text: { body: 'Hello LexAI' },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    it('accepts a valid, correctly-signed text message payload', () => {
      const raw = JSON.stringify(validPayload);
      return request(app.getHttpServer())
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(raw))
        .send(raw)
        .expect(200)
        .expect({ received: true });
    });

    it('rejects a payload missing required fields, even when correctly signed', () => {
      const raw = JSON.stringify({ object: 'whatsapp_business_account' });
      return request(app.getHttpServer())
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(raw))
        .send(raw)
        .expect(400);
    });

    it('rejects a request with no signature header', () => {
      const raw = JSON.stringify(validPayload);
      return request(app.getHttpServer())
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .send(raw)
        .expect(401);
    });

    it('rejects a request with an incorrect signature', () => {
      const raw = JSON.stringify(validPayload);
      return request(app.getHttpServer())
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64))
        .send(raw)
        .expect(401);
    });
  });
});
