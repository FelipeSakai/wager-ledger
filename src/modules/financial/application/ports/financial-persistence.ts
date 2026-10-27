import type { WagerState } from '../../domain/wagering/wager-state';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { InboxDelivery } from './inbox';

import type { OutboxWrite } from '../events/outbox-write';
import type { FinancialTransactionWrite } from '../transactions/transaction-write';

export interface FinancialPersistence {
  transactionCorrelation(transactionId: string): Promise<string | null>;
  hasFinancialEffect(transactionId: string): Promise<boolean>;
  setFailureCorrelation(correlationId: string): Promise<void>;
  checkInbox(delivery: InboxDelivery): Promise<void>;
  recordInbox(delivery: InboxDelivery, transactionId: string): Promise<void>;
  findWallet(playerId: string, currency: string): Promise<Wallet | null>;
  findByKey(key: string): Promise<WagerState | null>;
  findByExternalId(providerId: string, externalId: string): Promise<WagerState | null>;
  findWager(id: string): Promise<WagerState | null>;
  hasEffectiveReversal(referenceId: string): Promise<boolean>;
  lockWallet(id: string): Promise<Wallet>;
  insertWallet(wallet: Wallet): Promise<void>;
  appendMovement(
    entry: WalletLedgerEntry,
    transaction: FinancialTransactionWrite,
    events: readonly OutboxWrite[],
  ): Promise<void>;
  recordTransaction(
    transaction: FinancialTransactionWrite,
    events: readonly OutboxWrite[],
  ): Promise<void>;
}
