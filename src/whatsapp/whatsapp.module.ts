import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappApiService } from './whatsapp-api.service';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [HttpModule, QueueModule],
  controllers: [WhatsappController],
  providers: [WhatsappApiService],
  exports: [WhatsappApiService],
})
export class WhatsappModule {}
