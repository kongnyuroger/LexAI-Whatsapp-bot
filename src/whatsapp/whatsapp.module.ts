import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappApiService } from './whatsapp-api.service';

@Module({
  imports: [HttpModule],
  controllers: [WhatsappController],
  providers: [WhatsappApiService],
  exports: [WhatsappApiService],
})
export class WhatsappModule {}
