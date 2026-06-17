import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { ConversationModule } from '../conversation/conversation.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { IncomingMessageProcessor } from './incoming-message.processor';

@Module({
  imports: [QueueModule, ConversationModule, WhatsappModule],
  providers: [IncomingMessageProcessor],
})
export class MessagingModule {}
