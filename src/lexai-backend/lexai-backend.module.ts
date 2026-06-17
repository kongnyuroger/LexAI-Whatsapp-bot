import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { LexaiBackendService } from './lexai-backend.service';

@Module({
  imports: [HttpModule],
  providers: [LexaiBackendService],
  exports: [LexaiBackendService],
})
export class LexaiBackendModule {}
