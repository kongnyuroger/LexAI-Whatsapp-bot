import { Test, TestingModule } from '@nestjs/testing';
import { ConversationState } from '@prisma/client';
import { DocumentIntakeService } from './document-intake.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { LexaiBackendService } from '../lexai-backend/lexai-backend.service';
import { ConversationService } from '../conversation/conversation.service';
import { getQueueToken } from '@nestjs/bullmq';
import {
  ANALYZE_DOCUMENT_JOB,
  DOCUMENT_ANALYSIS_QUEUE,
} from '../queue/queue.constants';
import { MAX_FILE_SIZE_BYTES } from './document-intake.constants';

describe('DocumentIntakeService', () => {
  let service: DocumentIntakeService;
  let whatsappApiService: {
    sendTextMessage: jest.Mock;
    getMediaMetadata: jest.Mock;
    downloadMedia: jest.Mock;
  };
  let lexaiBackendService: { uploadDocument: jest.Mock };
  let conversationService: {
    ensureLinkedBackendUser: jest.Mock;
    transitionState: jest.Mock;
  };
  let analysisQueue: { add: jest.Mock };

  const user = {
    id: 'u1',
    phoneNumber: '+237600000000',
    lexaiAccessToken: 'token-abc',
  };
  const conversation = { id: 'c1', state: ConversationState.IDLE };

  beforeEach(async () => {
    whatsappApiService = {
      sendTextMessage: jest.fn(),
      getMediaMetadata: jest.fn(),
      downloadMedia: jest.fn(),
    };
    lexaiBackendService = { uploadDocument: jest.fn() };
    conversationService = {
      ensureLinkedBackendUser: jest.fn().mockResolvedValue(user),
      transitionState: jest.fn(),
    };
    analysisQueue = { add: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentIntakeService,
        { provide: WhatsappApiService, useValue: whatsappApiService },
        { provide: LexaiBackendService, useValue: lexaiBackendService },
        { provide: ConversationService, useValue: conversationService },
        {
          provide: getQueueToken(DOCUMENT_ANALYSIS_QUEUE),
          useValue: analysisQueue,
        },
      ],
    }).compile();

    service = module.get<DocumentIntakeService>(DocumentIntakeService);
  });

  it('rejects unsupported file types before calling the backend', async () => {
    await service.handleIncomingDocument(user as never, conversation as never, {
      from: user.phoneNumber,
      messageId: 'wamid.1',
      type: 'document',
      timestamp: '123',
      document: { id: 'media-1', mime_type: 'application/zip' },
    });

    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      expect.stringContaining('PDF, Word (.docx), or JPEG/PNG'),
    );
    expect(whatsappApiService.getMediaMetadata).not.toHaveBeenCalled();
    expect(lexaiBackendService.uploadDocument).not.toHaveBeenCalled();
  });

  it('rejects files larger than the configured maximum', async () => {
    whatsappApiService.getMediaMetadata.mockResolvedValueOnce({
      url: 'https://lookaside.fbsbx.com/media/abc',
      mimeType: 'application/pdf',
      fileSizeBytes: MAX_FILE_SIZE_BYTES + 1,
    });

    await service.handleIncomingDocument(user as never, conversation as never, {
      from: user.phoneNumber,
      messageId: 'wamid.2',
      type: 'document',
      timestamp: '123',
      document: { id: 'media-2', mime_type: 'application/pdf' },
    });

    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      expect.stringContaining('too large'),
    );
    expect(whatsappApiService.downloadMedia).not.toHaveBeenCalled();
    expect(lexaiBackendService.uploadDocument).not.toHaveBeenCalled();
  });

  it('uploads, acknowledges, transitions to PROCESSING, and enqueues analysis on success', async () => {
    whatsappApiService.getMediaMetadata.mockResolvedValueOnce({
      url: 'https://lookaside.fbsbx.com/media/abc',
      mimeType: 'application/pdf',
      fileSizeBytes: 1024,
    });
    whatsappApiService.downloadMedia.mockResolvedValueOnce(
      Buffer.from('pdf-bytes'),
    );
    lexaiBackendService.uploadDocument.mockResolvedValueOnce({
      id: 'doc-1',
      status: 'TEXT_EXTRACTED',
    });

    await service.handleIncomingDocument(user as never, conversation as never, {
      from: user.phoneNumber,
      messageId: 'wamid.3',
      type: 'document',
      timestamp: '123',
      document: {
        id: 'media-3',
        mime_type: 'application/pdf',
        filename: 'lease.pdf',
      },
    });

    expect(lexaiBackendService.uploadDocument).toHaveBeenCalledWith(
      'token-abc',
      Buffer.from('pdf-bytes'),
      'lease.pdf',
      'application/pdf',
    );
    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      expect.stringContaining('Got your document'),
    );
    expect(conversationService.transitionState).toHaveBeenCalledWith(
      'c1',
      ConversationState.PROCESSING,
      { activeDocumentId: 'doc-1' },
    );
    expect(analysisQueue.add).toHaveBeenCalledWith(ANALYZE_DOCUMENT_JOB, {
      documentId: 'doc-1',
      conversationId: 'c1',
      whatsappUserId: 'u1',
    });
  });

  it('sends a friendly error and does not proceed when upload succeeds but extraction failed', async () => {
    whatsappApiService.getMediaMetadata.mockResolvedValueOnce({
      url: 'https://lookaside.fbsbx.com/media/abc',
      mimeType: 'application/pdf',
      fileSizeBytes: 1024,
    });
    whatsappApiService.downloadMedia.mockResolvedValueOnce(
      Buffer.from('pdf-bytes'),
    );
    lexaiBackendService.uploadDocument.mockResolvedValueOnce({
      id: 'doc-1',
      status: 'FAILED',
    });

    await service.handleIncomingDocument(user as never, conversation as never, {
      from: user.phoneNumber,
      messageId: 'wamid.3b',
      type: 'document',
      timestamp: '123',
      document: { id: 'media-3b', mime_type: 'application/pdf' },
    });

    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      expect.stringContaining("couldn't read the text"),
    );
    expect(conversationService.transitionState).not.toHaveBeenCalled();
    expect(analysisQueue.add).not.toHaveBeenCalled();
  });

  it('sends a friendly error and does not enqueue analysis when the backend upload fails', async () => {
    whatsappApiService.getMediaMetadata.mockResolvedValueOnce({
      url: 'https://lookaside.fbsbx.com/media/abc',
      mimeType: 'application/pdf',
      fileSizeBytes: 1024,
    });
    whatsappApiService.downloadMedia.mockResolvedValueOnce(
      Buffer.from('pdf-bytes'),
    );
    lexaiBackendService.uploadDocument.mockRejectedValueOnce(
      new Error('upload failed'),
    );

    await service.handleIncomingDocument(user as never, conversation as never, {
      from: user.phoneNumber,
      messageId: 'wamid.4',
      type: 'document',
      timestamp: '123',
      document: { id: 'media-4', mime_type: 'application/pdf' },
    });

    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      expect.stringContaining('something went wrong'),
    );
    expect(conversationService.transitionState).not.toHaveBeenCalled();
    expect(analysisQueue.add).not.toHaveBeenCalled();
  });

  it('sends a friendly error when backend linking is not available yet', async () => {
    whatsappApiService.getMediaMetadata.mockResolvedValueOnce({
      url: 'https://lookaside.fbsbx.com/media/abc',
      mimeType: 'application/pdf',
      fileSizeBytes: 1024,
    });
    whatsappApiService.downloadMedia.mockResolvedValueOnce(
      Buffer.from('pdf-bytes'),
    );
    conversationService.ensureLinkedBackendUser.mockRejectedValueOnce(
      new Error('Cannot POST /auth/whatsapp-link'),
    );

    await service.handleIncomingDocument(user as never, conversation as never, {
      from: user.phoneNumber,
      messageId: 'wamid.5',
      type: 'document',
      timestamp: '123',
      document: { id: 'media-5', mime_type: 'application/pdf' },
    });

    expect(whatsappApiService.sendTextMessage).toHaveBeenCalledWith(
      user.phoneNumber,
      expect.stringContaining('something went wrong'),
    );
    expect(lexaiBackendService.uploadDocument).not.toHaveBeenCalled();
  });
});
