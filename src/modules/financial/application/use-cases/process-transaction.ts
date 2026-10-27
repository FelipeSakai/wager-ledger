import type { FinancialOperationContext } from '../ports/financial-telemetry';
import { isUuid } from '../../domain/validation/domain-validation';
import { type WagerState } from '../../domain/wagering/wager-state';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { FinancialError } from '../financial-error';
import { financialPolicy, type FinancialPolicy } from '../financial-policy';
import { financialRetry } from '../financial-retry';
import type { FinancialRuntime } from '../ports/financial-runtime';
import { report, silentTelemetry, type FinancialTelemetry } from '../ports/financial-telemetry';
import type { FinancialUnitOfWork } from '../ports/financial-unit-of-work';
import type { InboxDelivery } from '../ports/inbox';
import {
  canonicalTransaction,
  validateTransactionInput,
} from '../transactions/transaction-command';

import { applyTransaction } from '../transactions/apply-transaction';
import { submissionResult, type SubmissionResult } from '../transactions/submission-result';

export class ProcessTransaction {
  private readonly policy: FinancialPolicy;
  private readonly providers: ReadonlySet<string>;
  constructor(
    private readonly unit: FinancialUnitOfWork,
    private readonly runtime: FinancialRuntime,
    providers: readonly string[],
    policy: Partial<FinancialPolicy> = {},
    private readonly telemetry: FinancialTelemetry = silentTelemetry,
  ) {
    this.policy = financialPolicy(policy);
    this.providers = new Set(providers);
  }
  async execute(
    input: unknown,
    idempotencyKey: unknown,
    correlationId?: string,
    delivery?: InboxDelivery,
  ): Promise<SubmissionResult> {
    const { command, key } = validateTransactionInput(input, idempotencyKey);
    const hash = this.runtime.sha256(canonicalTransaction(command));
    const correlation = isUuid(correlationId) ? correlationId : this.runtime.newId();
    const context: FinancialOperationContext = {
      correlationId: correlation,
      walletId: command.walletId,
      providerId: command.providerId,
      messageId: delivery?.messageId,
    };
    const start = this.runtime.monotonicMilliseconds();
    const transport = delivery ? 'sqs' : 'http';
    try {
      const result = await financialRetry(
        this.runtime,
        () =>
          this.unit.run(
            async (persistence) => {
              if (delivery) await persistence.checkInbox(delivery);
              const replay = async (): Promise<WagerState | null> => {
                // READ COMMITTED may observe another commit between these reads.
                // Either identity can find the same winner; verify its key and payload.
                const found =
                  (await persistence.findByKey(key)) ??
                  (await persistence.findByExternalId(
                    command.providerId,
                    command.externalTransactionId,
                  ));
                if (!found) return null;
                if (found.idempotencyKey !== key)
                  throw new FinancialError('EXTERNAL_TRANSACTION_CONFLICT');
                if (found.payloadHash !== hash || found.payloadHashVersion !== 1)
                  throw new FinancialError('IDEMPOTENCY_CONFLICT');
                return found;
              };
              const found = await replay();
              if (found) context.transactionId = found.id;
              if (found && !delivery) return submissionResult(found, true, correlation);
              if (found && delivery) {
                await persistence.lockWallet(found.command.walletId);
                const current = await replay();
                if (!current) throw new FinancialError('INVALID_PERSISTED_TRANSACTION');
                await persistence.recordInbox(delivery, current.id);
                return submissionResult(current, true, correlation);
              }
              if (!this.providers.has(command.providerId))
                throw new FinancialError('UNKNOWN_PROVIDER');
              const wallet = await persistence.lockWallet(command.walletId);
              const raced = await replay();
              if (raced) {
                context.transactionId = raced.id;
                if (delivery) await persistence.recordInbox(delivery, raced.id);
                return submissionResult(raced, true, correlation);
              }
              const transaction = WagerTransaction.create({
                id: this.runtime.newId(),
                command,
                idempotencyKey: key,
                payloadHash: hash,
                payloadHashVersion: 1,
                createdAt: this.runtime.now(),
              });
              context.transactionId = transaction.snapshot().id;
              const state = await applyTransaction(
                transaction,
                wallet,
                persistence,
                this.runtime,
                correlation,
                this.policy,
              );
              if (delivery) await persistence.recordInbox(delivery, state.id);
              return submissionResult(state, false, correlation);
            },
            this.policy,
            context,
          ),
        this.policy,
        this.telemetry,
        context,
      );
      report(this.telemetry, {
        event: result.idempotentReplay ? 'transaction_replay' : 'transaction_transition',
        transactionId: result.transactionId,
        walletId: command.walletId,
        providerId: command.providerId,
        correlationId: correlation,
        messageId: delivery?.messageId,
        kind: command.kind,
        status: result.status,
        failureCode: result.failureCode,
        transport,
      });
      report(this.telemetry, {
        event: 'processing_completed',
        transport,
        outcome: result.idempotentReplay ? 'replay' : 'success',
        correlationId: correlation,
        transactionId: result.transactionId,
        durationSeconds: (this.runtime.monotonicMilliseconds() - start) / 1000,
      });
      return result;
    } catch (error: unknown) {
      report(this.telemetry, {
        event: 'processing_completed',
        transport,
        outcome: 'failure',
        correlationId: correlation,
        durationSeconds: (this.runtime.monotonicMilliseconds() - start) / 1000,
      });
      throw error;
    }
  }
}
