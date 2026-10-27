import type { WagerState } from '../../domain/wagering/wager-state';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionError } from '../../domain/wagering/wager-transaction-error';
import type { Wallet } from '../../domain/wallet/wallet';
import { financialOutbox } from '../events/financial-outbox';
import { PermanentReferenceFailure } from '../financial-error';
import { defaultFinancialPolicy, type FinancialPolicy } from '../financial-policy';
import type { FinancialPersistence } from '../ports/financial-persistence';
import type { FinancialRuntime } from '../ports/financial-runtime';
import { transactionWrite } from './transaction-write-mapper';

export async function applyTransaction(
  transaction: WagerTransaction,
  wallet: Wallet,
  persistence: FinancialPersistence,
  runtime: FinancialRuntime,
  correlationId: string,
  policy: FinancialPolicy = defaultFinancialPolicy,
): Promise<WagerState> {
  const before = transaction.snapshot();
  let reference: WagerState | null = null;
  if (before.command.referenceExternalTransactionId !== undefined) {
    try {
      reference = await persistence.findByExternalId(
        before.command.providerId,
        before.command.referenceExternalTransactionId,
      );
    } catch (error: unknown) {
      if (error instanceof WagerTransactionError && error.code === 'INVALID_PERSISTED_TRANSACTION')
        throw new PermanentReferenceFailure();
      throw error;
    }
  }
  const alreadyReversed = reference ? await persistence.hasEffectiveReversal(reference.id) : false;
  const at = runtime.now();
  const delay = Math.min(
    policy.referenceMaxDelayMilliseconds,
    policy.referenceBaseDelayMilliseconds * 2 ** Math.min(before.referenceAttempts, 30),
  );
  const entry = transaction.apply(wallet, {
    at,
    ledgerEntryId: runtime.newId(),
    reference: reference ?? undefined,
    alreadyReversed,
    nextReferenceAttemptAt: new Date(
      at.getTime() + Math.floor(delay * (0.5 + runtime.random() * 0.5)),
    ),
    referenceExpiresAt: new Date(before.createdAt.getTime() + policy.referenceWaitMilliseconds),
    maxReferenceAttempts: policy.referenceMaxAttempts,
  });
  const after = transaction.snapshot();
  const write = transactionWrite(after);
  const events =
    before.status === 'PENDING_REFERENCE' && after.status === 'PENDING_REFERENCE'
      ? []
      : financialOutbox(write, wallet.balance.toJSON(), correlationId, runtime, entry);
  if (entry) await persistence.appendMovement(entry, write, events);
  else await persistence.recordTransaction(write, events);
  return after;
}
