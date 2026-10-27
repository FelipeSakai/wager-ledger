import type { MoneyProps } from '../../domain/money/money';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { FinancialRuntime } from '../ports/financial-runtime';
import type { FinancialTransactionWrite } from '../transactions/transaction-write';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from './financial-events';
import type { OutboxWrite } from './outbox-write';

export function financialOutbox(
  transaction: FinancialTransactionWrite,
  balance: MoneyProps,
  correlationId: string,
  runtime: FinancialRuntime,
  entry?: WalletLedgerEntry,
): OutboxWrite[] {
  const events: OutboxWrite[] = [];
  const walletId = transaction.walletId.toLowerCase();
  const at = transaction.completedAt ?? transaction.createdAt;
  const metadata = () => ({
    eventId: runtime.newId(),
    aggregateId: walletId,
    correlationId,
    occurredAt: at,
  });
  const common = { transactionId: transaction.id, walletId };
  const push = (
    event:
      | WagerTransactionProcessed
      | WagerTransactionRejected
      | WalletBalanceChanged
      | WagerTransactionPendingReference,
  ): void => {
    const payload = event.toJSON();
    events.push({
      id: payload.eventId,
      transactionId: transaction.id,
      aggregateId: payload.aggregateId,
      eventType: event.eventType,
      eventVersion: 1,
      payload,
      occurredAt: new Date(payload.occurredAt),
    });
  };
  if (transaction.status === 'PROCESSED') {
    push(
      WagerTransactionProcessed.create(metadata(), {
        ...common,
        playerId: transaction.playerId,
        origin: transaction.origin,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        balance,
        processedAt: transaction.processedAt!.toISOString(),
        ...(transaction.origin === 'PROVIDER'
          ? {
              providerId: transaction.providerId!,
              externalTransactionId: transaction.externalTransactionId!,
            }
          : {}),
      }),
    );
    if (entry)
      push(
        WalletBalanceChanged.create(metadata(), {
          ...common,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: entry.walletVersion,
        }),
      );
  } else if (transaction.status === 'REJECTED') {
    push(
      WagerTransactionRejected.create(metadata(), {
        ...common,
        origin: transaction.origin,
        kind: transaction.kind,
        failureCode: transaction.failureCode!,
        rejectedAt: transaction.completedAt!.toISOString(),
      }),
    );
  } else if (transaction.status === 'PENDING_REFERENCE') {
    push(
      WagerTransactionPendingReference.create(metadata(), {
        ...common,
        providerId: transaction.providerId!,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId!,
        reason: transaction.pendingReason!,
        pendingAt: at.toISOString(),
      }),
    );
  }
  return events;
}
