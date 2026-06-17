import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { PrismaModule } from './prisma/prisma.module';
import { ConversationModule } from './conversation/conversation.module';
import { MessagingModule } from './messaging/messaging.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Global default: 100 req/60s per IP. POST /webhook overrides this much
    // higher via @Throttle() — Meta's webhook deliveries come from a shared
    // pool of egress IPs serving many WhatsApp users at once, so a tight
    // per-IP limit there would risk throttling legitimate traffic. The real
    // defense for that endpoint is the X-Hub-Signature-256 check
    // (WebhookSignatureGuard), not IP-based rate limiting.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    PrismaModule,
    HealthModule,
    WhatsappModule,
    ConversationModule,
    MessagingModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
