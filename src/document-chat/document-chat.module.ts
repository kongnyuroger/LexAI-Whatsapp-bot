import { Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { LexaiBackendModule } from '../lexai-backend/lexai-backend.module';
import { ConversationModule } from '../conversation/conversation.module';
import { DocumentChatService } from './document-chat.service';

@Module({
  imports: [WhatsappModule, LexaiBackendModule, ConversationModule],
  providers: [DocumentChatService],
  exports: [DocumentChatService],
})
export class DocumentChatModule {}
