import { Module } from '@nestjs/common';
import { AnalysisFormatterService } from './analysis-formatter.service';

@Module({
  providers: [AnalysisFormatterService],
  exports: [AnalysisFormatterService],
})
export class AnalysisFormatterModule {}
