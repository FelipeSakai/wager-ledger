import { createHash, randomUUID } from 'node:crypto';
import type { OutboxWrite } from '../../src/modules/financial/application/events/outbox-write';
import type { FinancialUnitOfWork } from '../../src/modules/financial/application/ports/financial-unit-of-work';
import type { FinancialTransactionWrite } from '../../src/modules/financial/application/transactions/transaction-write';
import { Money } from '../../src/modules/financial/domain/money/money';
import type { TransactionKind } from '../../src/modules/financial/domain/wagering/transaction-types';
import { Wallet } from '../../src/modules/financial/domain/wallet/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../src/modules/financial/domain/wallet/wallet-ledger-entry';

export const at = (): Date => new Date('2026-10-27T14:00:00.000Z');
export const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });

export function processedTransaction(
  wallet: Wallet,
  entry: WalletLedgerEntry,
  kind: TransactionKind,
  overrides: Partial<FinancialTransactionWrite> = {},
): FinancialTransactionWrite {
  const internal = kind === 'OPENING';
  const id = entry.transactionId;
  return {
    id,
    walletId: wallet.id,
    playerId: wallet.playerId,
    money: entry.money,
    origin: internal ? 'INTERNAL' : 'PROVIDER',
    kind,
    status: 'PROCESSED',
    ...(internal
      ? { internalIdentity: `opening:${wallet.id}` }
      : {
          providerId: 'provider-a',
          externalTransactionId: id,
          idempotencyKey: `provider-a:${id}`,
          payloadHash: createHash('sha256').update(id).digest('hex'),
          roundId: 'round-1',
          gameId: 'game-1',
        }),
    result: { transactionId: id, status: 'PROCESSED', balance: entry.balanceAfter.toJSON() },
    createdAt: entry.createdAt,
    processedAt: entry.createdAt,
    completedAt: entry.createdAt,
    ...overrides,
  };
}

export function eventsFor(
  transaction: FinancialTransactionWrite,
  entry?: WalletLedgerEntry,
): OutboxWrite[] {
  const events: OutboxWrite[] = [];
  const common = { transactionId: transaction.id, walletId: transaction.walletId };
  const add = (eventType: OutboxWrite['eventType'], data: Record<string, unknown>): void => {
    const id = randomUUID();
    const occurredAt = transaction.completedAt ?? transaction.createdAt;
    events.push({
      id,
      transactionId: transaction.id,
      aggregateId: transaction.walletId,
      eventType,
      eventVersion: 1,
      occurredAt,
      payload: {
        eventId: id,
        eventType,
        aggregateId: transaction.walletId,
        correlationId: randomUUID(),
        version: 1,
        occurredAt: occurredAt.toISOString(),
        data: { ...common, ...data },
      },
    });
  };
  if (transaction.status === 'PROCESSED') {
    add('WagerTransactionProcessed', {
      playerId: transaction.playerId,
      origin: transaction.origin,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      balance: transaction.result?.balance,
      processedAt: transaction.processedAt?.toISOString(),
      ...(transaction.origin === 'PROVIDER'
        ? {
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
          }
        : {}),
    });
    if (entry)
      add('WalletBalanceChanged', {
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      });
  } else if (transaction.status === 'REJECTED') {
    add('WagerTransactionRejected', {
      origin: transaction.origin,
      kind: transaction.kind,
      failureCode: transaction.failureCode,
    });
  } else if (transaction.status === 'PENDING_REFERENCE') {
    add('WagerTransactionPendingReference', {
      providerId: transaction.providerId,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      reason: 'REFERENCE_NOT_FOUND',
    });
  }
  return events;
}

export async function seedWallet(unit: FinancialUnitOfWork, amount = '100.00'): Promise<Wallet> {
  const wallet = Wallet.open({
    id: randomUUID(),
    playerId: randomUUID(),
    initialBalance: money(amount),
    at: at(),
  });
  await unit.run(async (tx) => {
    await tx.insertWallet(wallet);
    if (wallet.balance.isPositive()) {
      const entry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: randomUUID(),
        walletVersion: 1,
        direction: LedgerDirection.Credit,
        money: wallet.balance,
        balanceBefore: Money.zero(wallet.currency),
        balanceAfter: wallet.balance,
        createdAt: wallet.createdAt,
      });
      const transaction = processedTransaction(wallet, entry, 'OPENING');
      await tx.appendMovement(entry, transaction, eventsFor(transaction, entry));
    }
  });
  return wallet;
}

export function move(
  wallet: Wallet,
  direction: 'debit' | 'credit',
  amount: string,
): WalletLedgerEntry {
  return wallet[direction]({
    ledgerEntryId: randomUUID(),
    transactionId: randomUUID(),
    money: money(amount),
    at: at(),
  });
}
