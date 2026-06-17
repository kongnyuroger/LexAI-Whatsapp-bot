import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { ForbiddenException } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import {
  INCOMING_MESSAGE_JOB,
  INCOMING_MESSAGE_QUEUE,
} from '../queue/queue.constants';

describe('WhatsappController', () => {
  let controller: WhatsappController;
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    queue = { add: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WhatsappController],
      providers: [
        {
          provide: ConfigService,
          useValue: { get: () => 'test-verify-token' },
        },
        { provide: getQueueToken(INCOMING_MESSAGE_QUEUE), useValue: queue },
      ],
    }).compile();

    controller = module.get<WhatsappController>(WhatsappController);
  });

  describe('verifyWebhook', () => {
    it('returns the challenge when mode and token match', () => {
      const result = controller.verifyWebhook(
        'subscribe',
        'test-verify-token',
        'challenge-123',
      );
      expect(result).toBe('challenge-123');
    });

    it('throws ForbiddenException when the token does not match', () => {
      expect(() =>
        controller.verifyWebhook('subscribe', 'wrong-token', 'challenge-123'),
      ).toThrow(ForbiddenException);
    });
  });

  describe('receiveWebhook', () => {
    it('enqueues one job per message in the payload', async () => {
      const result = await controller.receiveWebhook({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'entry-1',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15550783881',
                    phone_number_id: '106540352242922',
                  },
                  messages: [
                    {
                      from: '237600000000',
                      id: 'wamid.abc',
                      timestamp: '1749416383',
                      type: 'text',
                      text: { body: 'Hello' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      expect(result).toEqual({ received: true });
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(INCOMING_MESSAGE_JOB, {
        from: '237600000000',
        messageId: 'wamid.abc',
        type: 'text',
        timestamp: '1749416383',
        text: { body: 'Hello' },
        image: undefined,
        document: undefined,
      });
    });

    it('does nothing when the payload has no messages (e.g. a status update)', async () => {
      const result = await controller.receiveWebhook({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'entry-1',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15550783881',
                    phone_number_id: '106540352242922',
                  },
                  statuses: [{ status: 'delivered' }],
                },
              },
            ],
          },
        ],
      });

      expect(result).toEqual({ received: true });
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
