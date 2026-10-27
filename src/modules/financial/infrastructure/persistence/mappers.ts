import { Money } from '../../domain/money/money';
import { MoneyError } from '../../domain/money/money-error';
import { type PendingReason, type WagerState } from '../../domain/wagering/wager-state';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionError } from '../../domain/wagering/wager-transaction-error';
import { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { LedgerRecord, TransactionRecord, WalletRecord } from './records';
import { storedWagerResult } from './stored-wager-result';

export function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: { amount: record.balance, currency: record.currency },
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toLedger(record: LedgerRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    walletVersion: record.walletVersion,
    direction: record.direction as LedgerDirection,
    money: { amount: record.amount, currency: record.currency },
    balanceBefore: { amount: record.balanceBefore, currency: record.currency },
    balanceAfter: { amount: record.balanceAfter, currency: record.currency },
    createdAt: record.createdAt,
  });
}

export function toWager(record: TransactionRecord): WagerState {
  try {
    if (
      record.origin !== 'PROVIDER' ||
      !record.providerId ||
      !record.externalTransactionId ||
      !record.idempotencyKey ||
      !record.payloadHash ||
      record.payloadHashVersion !== 1 ||
      !record.roundId ||
      !record.gameId ||
      record.kind === 'OPENING'
    )
      throw new WagerTransactionError('INVALID_PERSISTED_TRANSACTION');
    const state: WagerState = {
      id: record.id,
      command: {
        providerId: record.providerId,
        externalTransactionId: record.externalTransactionId,
        walletId: record.walletId,
        playerId: record.playerId,
        roundId: record.roundId,
        gameId: record.gameId,
        kind: record.kind,
        money: Money.rehydrate({ amount: record.amount, currency: record.currency }),
        ...(record.referenceExternalTransactionId !== null
          ? { referenceExternalTransactionId: record.referenceExternalTransactionId }
          : {}),
      },
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      payloadHashVersion: 1,
      status: record.status,
      result: storedWagerResult(record.result),
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      createdAt: record.createdAt,
      processedAt: record.processedAt ?? undefined,
      completedAt: record.completedAt ?? undefined,
      referenceAttempts: record.referenceAttempts,
      nextReferenceAttemptAt: record.nextReferenceAttemptAt ?? undefined,
      referenceExpiresAt: record.referenceExpiresAt ?? undefined,
      pendingReason: record.pendingReason as PendingReason | undefined,
    };
    if (state.pendingReason === null) state.pendingReason = undefined;
    return WagerTransaction.rehydrate(state).snapshot();
  } catch (error: unknown) {
    if (error instanceof WagerTransactionError || error instanceof MoneyError)
      throw new WagerTransactionError('INVALID_PERSISTED_TRANSACTION');
    throw error;
  }
}
