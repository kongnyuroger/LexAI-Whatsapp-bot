import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { ConversationModule } from '../conversation/conversation.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { DocumentIntakeModule } from '../document-intake/document-intake.module';
import { IncomingMessageProcessor } from './incoming-message.processor';

@Module({
  imports: [
    QueueModule,
    ConversationModule,
    WhatsappModule,
    DocumentIntakeModule,
  ],
  providers: [IncomingMessageProcessor],
})
export class MessagingModule {}
