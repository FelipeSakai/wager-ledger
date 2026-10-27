import type { FinancialOperationContext } from '../ports/financial-telemetry';
import { isUuid } from '../../domain/validation/domain-validation';
import { type WagerState } from '../../domain/wagering/wager-state';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionError } from '../../domain/wagering/wager-transaction-error';
import { FinancialError, RolledBackFinancialFailure } from '../financial-error';
import { financialPolicy, type FinancialPolicy } from '../financial-policy';
import { financialRetry } from '../financial-retry';
import type { FinancialRuntime } from '../ports/financial-runtime';
import { report, silentTelemetry, type FinancialTelemetry } from '../ports/financial-telemetry';
import type { FinancialUnitOfWork } from '../ports/financial-unit-of-work';
import { applyTransaction } from '../transactions/apply-transaction';
import { submissionResult, type SubmissionResult } from '../transactions/submission-result';
import { transactionWrite } from '../transactions/transaction-write-mapper';

// Every candidate is revalidated under the wallet lock, including recovery after rollback.
export class ResumePendingTransaction {
  private readonly policy: FinancialPolicy;
  constructor(
    private readonly unit: FinancialUnitOfWork,
    private readonly runtime: FinancialRuntime,
    policy: Partial<FinancialPolicy> = {},
    private readonly telemetry: FinancialTelemetry = silentTelemetry,
  ) {
    this.policy = financialPolicy(policy);
  }
  async execute(id: string, correlationId?: string): Promise<SubmissionResult | null> {
    if (!isUuid(id)) throw new FinancialError('INVALID_TRANSACTION_INPUT');
    let correlation = isUuid(correlationId) ? correlationId : this.runtime.newId();
    const context: FinancialOperationContext = { correlationId: correlation, transactionId: id };
    let attempted: WagerState | undefined;
    let observed: WagerState | undefined;
    const start = this.runtime.monotonicMilliseconds();
    const finish = (result: SubmissionResult | null) => {
      if (result && observed && !result.idempotentReplay && result.status !== observed.status)
        report(this.telemetry, {
          event: 'transaction_transition',
          transactionId: id,
          walletId: observed.command.walletId,
          providerId: observed.command.providerId,
          correlationId: correlation,
          kind: observed.command.kind,
          status: result.status,
          failureCode: result.failureCode,
          transport: 'references',
        });
      report(this.telemetry, {
        event: 'processing_completed',
        transport: 'references',
        outcome: result?.idempotentReplay ? 'replay' : 'success',
        correlationId: correlation,
        transactionId: id,
        durationSeconds: (this.runtime.monotonicMilliseconds() - start) / 1000,
      });
      return result;
    };
    try {
      return finish(
        await financialRetry(
          this.runtime,
          () =>
            this.unit.run(
              async (persistence) => {
                attempted = undefined;
                const candidate = await persistence.findWager(id);
                if (!candidate) return null;
                context.walletId = candidate.command.walletId;
                context.providerId = candidate.command.providerId;
                if (candidate.status === 'PENDING_REFERENCE' && !isUuid(correlationId)) {
                  const original = await persistence.transactionCorrelation(id);
                  if (isUuid(original)) {
                    correlation = original;
                    context.correlationId = original;
                  }
                }
                const wallet = await persistence.lockWallet(candidate.command.walletId);
                const current = await persistence.findWager(id);
                if (!current) throw new FinancialError('INVALID_PERSISTED_TRANSACTION');
                if (
                  current.status !== 'PENDING_REFERENCE' ||
                  current.nextReferenceAttemptAt! > this.runtime.now()
                ) {
                  return submissionResult(current, true, correlation);
                }
                attempted = current;
                observed = current;
                const state = await applyTransaction(
                  WagerTransaction.rehydrate(current),
                  wallet,
                  persistence,
                  this.runtime,
                  correlation,
                  this.policy,
                );
                return submissionResult(state, false, correlation);
              },
              this.policy,
              context,
            ),
          this.policy,
          this.telemetry,
          context,
        ),
      );
    } catch (error: unknown) {
      if (!(error instanceof RolledBackFinancialFailure) || !attempted) {
        report(this.telemetry, {
          event: 'processing_completed',
          transport: 'references',
          outcome: 'failure',
          correlationId: correlation,
          transactionId: id,
          durationSeconds: (this.runtime.monotonicMilliseconds() - start) / 1000,
        });
        throw error;
      }
      const failedAttempt = attempted;
      return finish(
        await financialRetry(
          this.runtime,
          () =>
            this.unit.run(
              async (persistence) => {
                const wallet = await persistence.lockWallet(failedAttempt.command.walletId);
                const current = await persistence.findWager(id);
                if (!current) throw new FinancialError('INVALID_PERSISTED_TRANSACTION');
                if (
                  current.status !== 'PENDING_REFERENCE' ||
                  current.referenceAttempts !== failedAttempt.referenceAttempts ||
                  current.nextReferenceAttemptAt?.getTime() !==
                    failedAttempt.nextReferenceAttemptAt?.getTime()
                ) {
                  return submissionResult(current, true, correlation);
                }
                if (
                  current.payloadHash !== failedAttempt.payloadHash ||
                  (await persistence.hasFinancialEffect(id))
                ) {
                  throw new FinancialError('INVALID_PERSISTED_TRANSACTION');
                }
                // Recheck the classified fault in this fresh context. A repaired/available
                // reference wins; only the same still-invalid dependency can terminate it.
                try {
                  await persistence.findByExternalId(
                    current.command.providerId,
                    current.command.referenceExternalTransactionId!,
                  );
                  return submissionResult(current, true, correlation);
                } catch (fault: unknown) {
                  if (
                    !(fault instanceof WagerTransactionError) ||
                    fault.code !== 'INVALID_PERSISTED_TRANSACTION'
                  )
                    throw fault;
                }
                const transaction = WagerTransaction.rehydrate(current);
                transaction.failReference(wallet, this.runtime.now());
                await persistence.setFailureCorrelation(correlation);
                const state = transaction.snapshot();
                // SQL routing creates the immutable diagnostic and canonical SQS transfer, if any.
                await persistence.recordTransaction(transactionWrite(state), []);
                return submissionResult(state, false, correlation);
              },
              this.policy,
              context,
            ),
          this.policy,
          this.telemetry,
          context,
        ),
      );
    }
  }
}
