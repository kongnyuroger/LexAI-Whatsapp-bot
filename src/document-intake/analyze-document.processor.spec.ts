import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ConversationState } from '@prisma/client';
import { AnalyzeDocumentProcessor } from './analyze-document.processor';
import { ConversationService } from '../conversation/conversation.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { LexaiBackendService } from '../lexai-backend/lexai-backend.service';
import { AnalyzeDocumentJobData } from './analyze-document.types';
import { MAX_POLL_ATTEMPTS } from './document-intake.constants';
import {
  DOCUMENT_ANALYSIS_QUEUE,
  POLL_ANALYSIS_JOB,
  TRIGGER_ANALYSIS_JOB,
} from '../queue/queue.constants';

function makeJob(
  name: string,
  data: AnalyzeDocumentJobData,
): Job<AnalyzeDocumentJobData> {
  return {
    name,
    data,
    id: 'job-1',
    attemptsMade: 1,
  } as Job<AnalyzeDocumentJobData>;
}

describe('AnalyzeDocumentProcessor', () => {
  let processor: AnalyzeDocumentProcessor;
  let conversationService: {
    findUserById: jest.Mock;
    transitionState: jest.Mock;
  };
  let whatsappApiService: { sendTextMessage: jest.Mock };
  let lexaiBackendService: {
    analyzeDocument: jest.Mock;
    getDocument: jest.Mock;
  };
  let analysisQueue: { add: jest.Mock };

  const user = {
    id: 'u1',
    phoneNumber: '+237600000000',
    lexaiAccessToken: 'token-abc',
  };

  beforeEach(async () => {
    conversationService = {
      findUserById: jest.fn().mockResolvedValue(user),
      transitionState: jest.fn(),
    };
    whatsappApiService = { sendTextMessage: jest.fn() };
    lexaiBackendService = {
      analyzeDocument: jest.fn(),
      getDocument: jest.fn(),
    };
    analysisQueue = { add: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyzeDocumentProcessor,
        { provide: ConversationService, useValue: conversationService },
        { provide: WhatsappApiService, useValue: whatsappApiService },
        { provide: LexaiBackendService, useValue: lexaiBackendService },
        {
          provide: getQueueToken(DOCUMENT_ANALYSIS_QUEUE),
          useValue: analysisQueue,
        },
      ],
    }).compile();

    processor = module.get<AnalyzeDocumentProcessor>(AnalyzeDocumentProcessor);
  });

  it('triggers analysis and enqueues the first poll job', async () => {
    await processor.process(
      makeJob(TRIGGER_ANALYSIS_JOB, {
        documentId: 'doc-1',
        conversationId: 'c1',
        whatsappUserId: 'u1',
      }),
    );

    expect(lexaiBackendService.analyzeDocument).toHaveBeenCalledWith(
      'token-abc',
      'doc-1',
    );
    expect(analysisQueue.add).toHaveBeenCalledWith(
      POLL_ANALYSIS_JOB,
      {
        documentId: 'doc-1',
        conversationId: 'c1',
        whatsappUserId: 'u1',
        pollAttempt: 0,
      },
      { delay: 5000 },
    );
  });

  it('transitions to ANALYZED and notifies the user once the backend reports ANALYZED', async () => {
    lexaiBackendService.getDocument.mockResolvedValueOnce({
      id: 'doc-1',
      status: 'ANALYZED',
    });

    await processor.process(
      makeJob(POLL_ANALYSIS_JOB, {
        documentId: 'doc-1',
        conversationId: 'c1',
        whatsappUserId: 'u1',
        pollAttempt: 2,
      }),
    );

    expect(conversationService.transitionState).toHaveBeenCalledWith(
      'c1',
      ConversationState.ANALYZED,
    );
    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      expect.stringContaining('ready'),
    );
    expect(analysisQueue.add).not.toHaveBeenCalled();
  });

  it('transitions back to IDLE and notifies the user when the backend reports FAILED', async () => {
    lexaiBackendService.getDocument.mockResolvedValueOnce({
      id: 'doc-1',
      status: 'FAILED',
    });

    await processor.process(
      makeJob(POLL_ANALYSIS_JOB, {
        documentId: 'doc-1',
        conversationId: 'c1',
        whatsappUserId: 'u1',
        pollAttempt: 2,
      }),
    );

    expect(conversationService.transitionState).toHaveBeenCalledWith(
      'c1',
      ConversationState.IDLE,
    );
    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      expect.stringContaining("couldn't analyze"),
    );
  });

  it('re-enqueues another poll job while still PROCESSING', async () => {
    lexaiBackendService.getDocument.mockResolvedValueOnce({
      id: 'doc-1',
      status: 'PROCESSING',
    });

    await processor.process(
      makeJob(POLL_ANALYSIS_JOB, {
        documentId: 'doc-1',
        conversationId: 'c1',
        whatsappUserId: 'u1',
        pollAttempt: 2,
      }),
    );

    expect(analysisQueue.add).toHaveBeenCalledWith(
      POLL_ANALYSIS_JOB,
      {
        documentId: 'doc-1',
        conversationId: 'c1',
        whatsappUserId: 'u1',
        pollAttempt: 3,
      },
      { delay: 5000 },
    );
    expect(conversationService.transitionState).not.toHaveBeenCalled();
  });

  it('gives up and resets to IDLE after the max poll attempts (slow processing timeout)', async () => {
    lexaiBackendService.getDocument.mockResolvedValueOnce({
      id: 'doc-1',
      status: 'PROCESSING',
    });

    await processor.process(
      makeJob(POLL_ANALYSIS_JOB, {
        documentId: 'doc-1',
        conversationId: 'c1',
        whatsappUserId: 'u1',
        pollAttempt: MAX_POLL_ATTEMPTS - 1,
      }),
    );

    expect(conversationService.transitionState).toHaveBeenCalledWith(
      'c1',
      ConversationState.IDLE,
    );
    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      expect.stringContaining('longer than expected'),
    );
    expect(analysisQueue.add).not.toHaveBeenCalled();
  });

  it('logs and skips work when the user has no lexai-backend token', async () => {
    conversationService.findUserById.mockResolvedValueOnce({
      ...user,
      lexaiAccessToken: null,
    });

    await processor.process(
      makeJob(TRIGGER_ANALYSIS_JOB, {
        documentId: 'doc-1',
        conversationId: 'c1',
        whatsappUserId: 'u1',
      }),
    );

    expect(lexaiBackendService.analyzeDocument).not.toHaveBeenCalled();
  });
});
