import { Test, TestingModule } from '@nestjs/testing';
import { AnalysisFormatterService } from './analysis-formatter.service';
import { AnalysisResult } from '../lexai-backend/lexai-backend.service';
import { SAFE_MESSAGE_LENGTH } from './analysis-formatter.constants';

describe('AnalysisFormatterService', () => {
  let service: AnalysisFormatterService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AnalysisFormatterService],
    }).compile();

    service = module.get<AnalysisFormatterService>(AnalysisFormatterService);
  });

  function baseAnalysis(
    overrides: Partial<AnalysisResult> = {},
  ): AnalysisResult {
    return {
      documentId: 'doc-1',
      summary: {
        purpose: 'Residential lease agreement between landlord and tenant.',
        mainParties: ['Alice Nkeng (Landlord)', 'Bob Tabi (Tenant)'],
        importantDates: ['Lease start: 2026-01-01', 'Lease end: 2026-12-31'],
        moneyInvolved: ['Monthly rent: 50,000 XAF', 'Deposit: 100,000 XAF'],
        responsibilities: ['Tenant pays rent by the 1st of each month'],
      },
      riskFlags: [],
      ...overrides,
    };
  }

  it('includes the purpose, parties, dates, money, and responsibilities in the summary message', () => {
    const messages = service.format(baseAnalysis());
    const summary = messages[0];

    expect(summary).toContain('Residential lease agreement');
    expect(summary).toContain('Alice Nkeng (Landlord)');
    expect(summary).toContain('Lease start: 2026-01-01');
    expect(summary).toContain('Monthly rent: 50,000 XAF');
    expect(summary).toContain('Tenant pays rent by the 1st');
  });

  it('says no risks were flagged when there are zero risk flags', () => {
    const messages = service.format(baseAnalysis({ riskFlags: [] }));
    const riskMessage = messages.find((m) => m.includes('Risk Flags'));

    expect(riskMessage).toContain('No major risks');
    expect(riskMessage).not.toMatch(/🔴|🟠/);
  });

  it('groups many risk flags by severity with emoji indicators', () => {
    const messages = service.format(
      baseAnalysis({
        riskFlags: [
          {
            severity: 'HIGH',
            clauseText: 'Clause A',
            explanation: 'High risk explanation',
          },
          {
            severity: 'LOW',
            clauseText: 'Clause B',
            explanation: 'Low risk explanation',
          },
          {
            severity: 'MEDIUM',
            clauseText: 'Clause C',
            explanation: 'Medium risk explanation',
          },
          {
            severity: 'HIGH',
            clauseText: 'Clause D',
            explanation: 'Another high risk',
          },
        ],
      }),
    );
    const riskMessage = messages.find((m) => m.includes('Risk Flags'))!;

    expect(riskMessage).toContain('🔴');
    expect(riskMessage).toContain('🟠');
    expect(riskMessage).toContain('🟢');
    // HIGH severity items should appear before MEDIUM and LOW
    expect(riskMessage.indexOf('High risk explanation')).toBeLessThan(
      riskMessage.indexOf('Medium risk explanation'),
    );
    expect(riskMessage.indexOf('Medium risk explanation')).toBeLessThan(
      riskMessage.indexOf('Low risk explanation'),
    );
  });

  it('ends with a nudge to ask questions and the not-legal-advice disclaimer', () => {
    const messages = service.format(baseAnalysis());
    const closing = messages[messages.length - 1];

    expect(closing.toLowerCase()).toContain('ask me');
    expect(closing.toLowerCase()).toContain('not legal advice');
  });

  it('never emits a message longer than the safe length, even with many risk flags', () => {
    const manyFlags = Array.from({ length: 40 }, (_, i) => ({
      severity: 'HIGH' as const,
      clauseText: `Clause ${i}`,
      explanation: `This is a fairly detailed explanation of risk number ${i} that adds a meaningful amount of text to the overall message length.`,
    }));

    const messages = service.format(baseAnalysis({ riskFlags: manyFlags }));

    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(SAFE_MESSAGE_LENGTH);
    }
    // Risk flags alone should have required more than one message.
    expect(messages.length).toBeGreaterThan(2);
  });

  it('word-wraps a single explanation that alone exceeds the safe length', () => {
    const longExplanation = Array.from(
      { length: 400 },
      (_, i) => `word${i}`,
    ).join(' ');
    const messages = service.format(
      baseAnalysis({
        riskFlags: [
          {
            severity: 'HIGH',
            clauseText: 'Clause A',
            explanation: longExplanation,
          },
        ],
      }),
    );

    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(SAFE_MESSAGE_LENGTH);
    }
  });
});
