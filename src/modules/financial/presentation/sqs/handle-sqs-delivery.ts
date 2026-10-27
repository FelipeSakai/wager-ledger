import type { FinancialOperationContext } from '../../application/ports/financial-telemetry';
import { isUuid } from '../../domain/validation/domain-validation';
import { FinancialError } from '../../application/financial-error';
import type { SqsRecoveryStore } from '../../application/ports/dlq-recovery-store';
import type { FinancialRuntime } from '../../application/ports/financial-runtime';
import {
  report,
  silentTelemetry,
  type FinancialTelemetry,
} from '../../application/ports/financial-telemetry';
import type { QueueDelivery } from '../../application/ports/queue-transport';
import type { ProcessTransaction } from '../../application/use-cases/process-transaction';
import { MoneyError } from '../../domain/money/money-error';
import { transactionEnvelope } from './transaction-envelope';
export type SqsDisposition = { acknowledge: boolean; transferId?: string };
const permanentCodes = new Set([
  'INVALID_TRANSACTION_INPUT',
  'INVALID_IDEMPOTENCY_KEY',
  'UNKNOWN_PROVIDER',
  'UNSUPPORTED_TRANSACTION_CURRENCY',
  'WALLET_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'EXTERNAL_TRANSACTION_CONFLICT',
  'INBOX_PAYLOAD_CONFLICT',
  'INVALID_SQS_ENVELOPE',
  'INVALID_MESSAGE_GROUP',
]);
export class HandleSqsDelivery {
  constructor(
    private readonly processor: ProcessTransaction,
    private readonly recovery: SqsRecoveryStore,
    private readonly runtime: FinancialRuntime,
    private readonly sourceQueue: string,
    private readonly dlqQueue: string,
    private readonly consumerName = 'wager-transactions-v1',
    private readonly telemetry: FinancialTelemetry = silentTelemetry,
  ) {}
  async execute(
    delivery: QueueDelivery,
    context: FinancialOperationContext = {},
  ): Promise<SqsDisposition> {
    try {
      const envelope = transactionEnvelope(delivery.body);
      if (delivery.groupId !== envelope.walletId) throw new FinancialError('INVALID_MESSAGE_GROUP');
      const correlationId = isUuid(context.correlationId)
        ? context.correlationId
        : this.runtime.newId();
      Object.assign(context, {
        correlationId,
        messageId: envelope.messageId,
        walletId: envelope.walletId,
        providerId: envelope.input.providerId,
      });
      const previous = await this.recovery.decision(this.consumerName, envelope.messageId);
      const result = await this.processor.execute(envelope.input, envelope.key, correlationId, {
        id: this.runtime.newId(),
        consumerName: this.consumerName,
        messageId: envelope.messageId,
        payloadHash: this.runtime.sha256(envelope.canonical),
        body: delivery.body,
        sourceQueue: this.sourceQueue,
        transportMessageId: delivery.transportMessageId,
        groupId: delivery.groupId,
        dlqQueue: this.dlqQueue,
        receivedAt: this.runtime.now(),
      });
      context.transactionId = result.transactionId;
      const decision = await this.recovery.decision(this.consumerName, envelope.messageId);
      if (!decision) throw new Error('Committed inbox was not found');
      if (previous)
        report(this.telemetry, {
          event: 'inbox_duplicate',
          correlationId,
          messageId: envelope.messageId,
          transactionId: decision.transactionId,
          walletId: envelope.walletId,
        });
      report(this.telemetry, {
        event: 'sqs_delivery',
        correlationId,
        messageId: envelope.messageId,
        transactionId: decision.transactionId,
        walletId: envelope.walletId,
        outcome: decision.disposition === 'DLQ_REQUIRED' ? 'dlq' : 'success',
      });
      return {
        acknowledge: decision.disposition === 'ACK_AFTER_COMMIT' || decision.dlqConfirmed,
        transferId: decision.transferId,
      };
    } catch (error: unknown) {
      const permanent =
        (error instanceof FinancialError && permanentCodes.has(error.code)) ||
        (error instanceof MoneyError &&
          ['INVALID_MONEY_AMOUNT', 'INVALID_CURRENCY', 'MONEY_OUT_OF_RANGE'].includes(error.code));
      if (!permanent) throw error;
      const bodyHash = this.runtime.sha256(delivery.body);
      const id = await this.recovery.diagnose({
        id: this.runtime.newId(),
        diagnosticKey: this.runtime.sha256(
          JSON.stringify([
            this.consumerName,
            this.sourceQueue,
            delivery.transportMessageId,
            bodyHash,
          ]),
        ),
        consumerName: this.consumerName,
        bodyHash,
        body: delivery.body,
        sourceQueue: this.sourceQueue,
        transportMessageId: delivery.transportMessageId,
        groupId: delivery.groupId,
        destination: this.dlqQueue,
        reason: error.code,
      });
      return { acknowledge: await this.recovery.confirmed(id), transferId: id };
    }
  }
}
