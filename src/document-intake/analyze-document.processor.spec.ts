import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { AxiosError, AxiosResponse } from 'axios';
import { ConversationState } from '@prisma/client';
import { AnalyzeDocumentProcessor } from './analyze-document.processor';
import { ConversationService } from '../conversation/conversation.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { LexaiBackendService } from '../lexai-backend/lexai-backend.service';
import { AnalysisFormatterService } from '../analysis-formatter/analysis-formatter.service';
import { AnalyzeDocumentJobData } from './analyze-document.types';

function axiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as never,
  };
}

function makeJob(
  data: AnalyzeDocumentJobData,
  opts: { attemptsMade?: number; attempts?: number } = {},
): Job<AnalyzeDocumentJobData> {
  return {
    data,
    id: 'job-1',
    attemptsMade: opts.attemptsMade ?? 1,
    opts: { attempts: opts.attempts ?? 3 },
  } as Job<AnalyzeDocumentJobData>;
}

describe('AnalyzeDocumentProcessor', () => {
  let processor: AnalyzeDocumentProcessor;
  let conversationService: {
    findUserById: jest.Mock;
    transitionState: jest.Mock;
  };
  let whatsappApiService: { sendTextMessage: jest.Mock };
  let lexaiBackendService: { analyzeDocument: jest.Mock };
  let analysisFormatterService: { format: jest.Mock };

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
    lexaiBackendService = { analyzeDocument: jest.fn() };
    analysisFormatterService = { format: jest.fn().mockReturnValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyzeDocumentProcessor,
        { provide: ConversationService, useValue: conversationService },
        { provide: WhatsappApiService, useValue: whatsappApiService },
        { provide: LexaiBackendService, useValue: lexaiBackendService },
        {
          provide: AnalysisFormatterService,
          useValue: analysisFormatterService,
        },
      ],
    }).compile();

    processor = module.get<AnalyzeDocumentProcessor>(AnalyzeDocumentProcessor);
  });

  it('transitions to ANALYZED and sends the formatted messages when analysis succeeds', async () => {
    const analysis = {
      documentId: 'doc-1',
      summary: { purpose: 'Lease' },
      riskFlags: [],
    };
    lexaiBackendService.analyzeDocument.mockResolvedValueOnce(analysis);
    analysisFormatterService.format.mockReturnValueOnce([
      'Summary message',
      'Risk flags message',
      'Closing message',
    ]);

    await processor.process(
      makeJob({
        documentId: 'doc-1',
        conversationId: 'c1',
        whatsappUserId: 'u1',
      }),
    );

    expect(lexaiBackendService.analyzeDocument).toHaveBeenCalledWith(
      'token-abc',
      'doc-1',
    );
    expect(conversationService.transitionState).toHaveBeenCalledWith(
      'c1',
      ConversationState.ANALYZED,
    );
    expect(analysisFormatterService.format).toHaveBeenCalledWith(analysis);
    expect(whatsappApiService.sendTextMessage.mock.calls).toEqual([
      [user.phoneNumber, 'Summary message'],
      [user.phoneNumber, 'Risk flags message'],
      [user.phoneNumber, 'Closing message'],
    ]);
  });

  it('resets to IDLE with a plan-limit message on 403, without retrying', async () => {
    const error = new AxiosError('Forbidden');
    error.response = axiosResponse({ message: 'limit reached' });
    (error.response as AxiosResponse).status = 403;
    lexaiBackendService.analyzeDocument.mockRejectedValueOnce(error);

    await processor.process(
      makeJob({
        documentId: 'doc-1',
        conversationId: 'c1',
        whatsappUserId: 'u1',
      }),
    );

    expect(conversationService.transitionState).toHaveBeenCalledWith(
      'c1',
      ConversationState.IDLE,
    );
    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      expect.stringContaining('monthly document analysis limit'),
    );
  });

  it('resets to IDLE with a friendly message on 422 (text not extracted), without retrying', async () => {
    const error = new AxiosError('Unprocessable Entity');
    error.response = axiosResponse({ message: 'text not extracted' });
    (error.response as AxiosResponse).status = 422;
    lexaiBackendService.analyzeDocument.mockRejectedValueOnce(error);

    await processor.process(
      makeJob({
        documentId: 'doc-1',
        conversationId: 'c1',
        whatsappUserId: 'u1',
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

  it('rethrows unexpected errors so BullMQ retries instead of giving up immediately', async () => {
    const error = new AxiosError('Service Unavailable');
    error.response = axiosResponse({});
    (error.response as AxiosResponse).status = 503;
    lexaiBackendService.analyzeDocument.mockRejectedValueOnce(error);

    await expect(
      processor.process(
        makeJob({
          documentId: 'doc-1',
          conversationId: 'c1',
          whatsappUserId: 'u1',
        }),
      ),
    ).rejects.toThrow('Service Unavailable');

    expect(conversationService.transitionState).not.toHaveBeenCalled();
  });

  it('does nothing when the user has no lexai-backend token', async () => {
    conversationService.findUserById.mockResolvedValueOnce({
      ...user,
      lexaiAccessToken: null,
    });

    await processor.process(
      makeJob({
        documentId: 'doc-1',
        conversationId: 'c1',
        whatsappUserId: 'u1',
      }),
    );

    expect(lexaiBackendService.analyzeDocument).not.toHaveBeenCalled();
  });

  describe('onFailed', () => {
    it('does not notify the user while more retries remain', async () => {
      const job = makeJob(
        { documentId: 'doc-1', conversationId: 'c1', whatsappUserId: 'u1' },
        { attemptsMade: 1, attempts: 3 },
      );

      await processor.onFailed(job, new Error('boom'));

      expect(whatsappApiService.sendTextMessage).not.toHaveBeenCalled();
    });

    it('resets to IDLE and notifies the user once all retries are exhausted', async () => {
      const job = makeJob(
        { documentId: 'doc-1', conversationId: 'c1', whatsappUserId: 'u1' },
        { attemptsMade: 3, attempts: 3 },
      );

      await processor.onFailed(job, new Error('boom'));

      expect(conversationService.transitionState).toHaveBeenCalledWith(
        'c1',
        ConversationState.IDLE,
      );
      expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
        user.phoneNumber,
        expect.stringContaining('something went wrong'),
      );
    });
  });
});
