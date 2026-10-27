import type { SqsRecoveryStore } from '../ports/dlq-recovery-store';
import type { FinancialRuntime } from '../ports/financial-runtime';
import { report, silentTelemetry, type FinancialTelemetry } from '../ports/financial-telemetry';
import type { SqsTransport } from '../ports/queue-transport';
export class DispatchDlq {
  constructor(
    private readonly store: SqsRecoveryStore,
    private readonly transport: SqsTransport,
    private readonly runtime: FinancialRuntime,
    private readonly policy = {
      leaseMilliseconds: 30000,
      maxAttempts: 10,
      baseDelayMilliseconds: 1000,
      maxDelayMilliseconds: 300000,
    },
    private readonly telemetry: FinancialTelemetry = silentTelemetry,
  ) {}
  async execute(id?: string): Promise<boolean> {
    if (id && (await this.store.confirmed(id))) return true;
    const transfer = await this.store.claim(id, this.policy.leaseMilliseconds);
    if (!transfer) return false;
    const context = {
      transferId: transfer.id,
      transactionId: transfer.transactionId,
      correlationId: transfer.correlationId,
      messageId: transfer.messageId,
      walletId: transfer.groupId,
    };
    try {
      await this.transport.send(
        transfer.destination,
        transfer.body,
        transfer.groupId,
        transfer.id,
        {
          transferId: transfer.id,
          sourceTransportMessageId: transfer.sourceTransportMessageId,
          reason: transfer.reason,
        },
      );
      report(this.telemetry, { event: 'dlq_transfer', ...context, outcome: 'success' });
    } catch {
      const delay = Math.min(
        this.policy.maxDelayMilliseconds,
        this.policy.baseDelayMilliseconds * 2 ** Math.min(transfer.attempts, 20),
      );
      report(this.telemetry, { event: 'dlq_transfer', ...context, outcome: 'failure' });
      await this.store.fail(
        transfer.id,
        transfer.claimToken,
        Math.floor(delay * (0.5 + this.runtime.random() * 0.5)),
        this.policy.maxAttempts,
      );
      return false;
    }
    const confirmed = await this.store.confirm(transfer.id, transfer.claimToken);
    report(this.telemetry, {
      event: 'dlq_transfer',
      ...context,
      outcome: confirmed ? 'confirmed' : 'lost',
    });
    return confirmed;
  }
}
