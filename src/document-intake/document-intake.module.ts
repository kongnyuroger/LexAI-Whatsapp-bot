import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { LexaiBackendModule } from '../lexai-backend/lexai-backend.module';
import { ConversationModule } from '../conversation/conversation.module';
import { AnalysisFormatterModule } from '../analysis-formatter/analysis-formatter.module';
import { DocumentIntakeService } from './document-intake.service';
import { AnalyzeDocumentProcessor } from './analyze-document.processor';

@Module({
  imports: [
    QueueModule,
    WhatsappModule,
    LexaiBackendModule,
    ConversationModule,
    AnalysisFormatterModule,
  ],
  providers: [DocumentIntakeService, AnalyzeDocumentProcessor],
  exports: [DocumentIntakeService],
})
export class DocumentIntakeModule {}
