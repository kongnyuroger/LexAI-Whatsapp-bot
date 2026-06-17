import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('Webhook (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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
    it('accepts a valid text message payload', () => {
      return request(app.getHttpServer())
        .post('/webhook')
        .send({
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
        })
        .expect(200)
        .expect({ received: true });
    });

    it('rejects a payload missing required fields', () => {
      return request(app.getHttpServer())
        .post('/webhook')
        .send({ object: 'whatsapp_business_account' })
        .expect(400);
    });
  });
});
