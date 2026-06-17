import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConversationService } from './conversation.service';

@Module({
  imports: [HttpModule],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
