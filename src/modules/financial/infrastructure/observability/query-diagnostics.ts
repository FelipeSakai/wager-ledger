import type { QueryDiagnostics } from '../../application/ports/financial-read-store';
import {
  report,
  silentTelemetry,
  type FinancialTelemetry,
} from '../../application/ports/financial-telemetry';

type DiagnosticRecord = Readonly<{
  level: 'error';
  event: string;
  correlationId: string;
  walletId?: string;
  issues?: readonly string[];
}>;
export class FinancialQueryDiagnostics implements QueryDiagnostics {
  private divergences = 0;
  private integrityFailures = 0;
  constructor(
    private readonly write: (record: DiagnosticRecord) => void = (record) =>
      console.error(JSON.stringify(record)),
    private readonly telemetry: FinancialTelemetry = silentTelemetry,
  ) {}
  reconciliationIssue(walletId: string, issues: readonly string[], correlationId: string): void {
    this.divergences++;
    report(this.telemetry, { event: 'reconciliation_issue', walletId, correlationId });
    try {
      this.write({
        level: 'error',
        event: 'financial_reconciliation_divergence',
        walletId,
        issues: [...issues],
        correlationId,
      });
    } catch {}
  }
  integrityFailure(correlationId: string): void {
    this.integrityFailures++;
    report(this.telemetry, { event: 'integrity_failure', correlationId });
    try {
      this.write({
        level: 'error',
        event: 'financial_integrity_or_internal_failure',
        correlationId,
      });
    } catch {}
  }
  counters() {
    return {
      reconciliationDivergences: this.divergences,
      integrityFailures: this.integrityFailures,
    };
  }
}
