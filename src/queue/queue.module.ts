import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import {
  DOCUMENT_ANALYSIS_QUEUE,
  INCOMING_MESSAGE_QUEUE,
} from './queue.constants';

// Parsed into a plain options object (rather than handing BullMQ an ioredis
// instance we construct ourselves) to avoid a duplicate-ioredis-version type
// clash with the copy bundled inside bullmq's own dependency tree.
export function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    // `rediss://` (e.g. Upstash) requires TLS on the same port; without this,
    // ioredis attempts a plain handshake and the server resets the connection.
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          ...parseRedisUrl(
            config.get<string>('REDIS_URL', 'redis://localhost:6379'),
          ),
          // BullMQ requires this for its blocking commands; ioredis would
          // otherwise retry indefinitely and never surface a connection error.
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue(
      {
        name: INCOMING_MESSAGE_QUEUE,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 24 * 60 * 60 },
          // Keep failed jobs around (capped) instead of discarding them, so
          // they remain inspectable for debugging — our dead-letter handling.
          removeOnFail: { count: 1000 },
        },
      },
      {
        name: DOCUMENT_ANALYSIS_QUEUE,
        defaultJobOptions: {
          // POST /documents/:id/analyze is synchronous on lexai-backend's
          // side (it returns the full result or a definitive error in one
          // call) — these retries only cover transient failures actually
          // talking to it (e.g. a dropped connection), not "still working".
          attempts: 3,
          backoff: { type: 'fixed', delay: 3000 },
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: { count: 1000 },
        },
      },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
