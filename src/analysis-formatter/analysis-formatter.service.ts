import { Injectable } from '@nestjs/common';
import {
  AnalysisResult,
  AnalysisSummary,
  RiskFlag,
} from '../lexai-backend/lexai-backend.service';
import {
  SEVERITY_EMOJI,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
} from './analysis-formatter.constants';
import { splitWhatsappMessage } from '../common/whatsapp-text.util';

// Converts a lexai-backend analysis result into the sequence of WhatsApp
// text messages this bot sends back, since WhatsApp has no rich UI for
// structured data — a summary message, a risk-flags message (grouped by
// severity, using emoji as the email/SMS equivalent of the web app's
// colored Badge component), and a closing message with the standard
// disclaimer. Each is split further if it would exceed a readable length.
@Injectable()
export class AnalysisFormatterService {
  format(analysis: AnalysisResult): string[] {
    return [
      ...splitWhatsappMessage(this.formatSummary(analysis.summary)),
      ...splitWhatsappMessage(this.formatRiskFlags(analysis.riskFlags)),
      this.formatClosing(),
    ];
  }

  private formatSummary(summary: AnalysisSummary): string {
    const lines = ['📄 *Document Summary*', '', summary.purpose];

    this.appendListSection(lines, '*Parties involved:*', summary.mainParties);
    this.appendListSection(lines, '*Key dates:*', summary.importantDates);
    this.appendListSection(lines, '*Money involved:*', summary.moneyInvolved);
    this.appendListSection(
      lines,
      '*Key responsibilities:*',
      summary.responsibilities,
    );

    return lines.join('\n');
  }

  private appendListSection(
    lines: string[],
    heading: string,
    items: string[],
  ): void {
    if (items.length === 0) {
      return;
    }
    lines.push('', heading, ...items.map((item) => `- ${item}`));
  }

  private formatRiskFlags(riskFlags: RiskFlag[]): string {
    if (riskFlags.length === 0) {
      return '✅ *Risk Flags*\n\nNo major risks were flagged in this document.';
    }

    const bySeverity = new Map<string, RiskFlag[]>();
    for (const flag of riskFlags) {
      const group = bySeverity.get(flag.severity) ?? [];
      group.push(flag);
      bySeverity.set(flag.severity, group);
    }

    const lines = ['⚠️ *Risk Flags*', ''];
    for (const severity of SEVERITY_ORDER) {
      const flags = bySeverity.get(severity);
      if (!flags?.length) {
        continue;
      }
      lines.push(
        `${SEVERITY_EMOJI[severity]} *${SEVERITY_LABEL[severity]} risk*`,
      );
      for (const flag of flags) {
        lines.push(`- ${flag.explanation}`);
      }
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  private formatClosing(): string {
    return [
      'You can now ask me questions about this document — just type your question here.',
      '',
      '_This is general information, not legal advice. Consult a qualified lawyer for advice on your specific situation._',
    ].join('\n');
  }
}
