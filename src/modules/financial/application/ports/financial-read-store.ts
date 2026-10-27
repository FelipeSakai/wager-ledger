import type { MoneyProps } from '../../domain/money/money';
import type { TransactionKind, TransactionStatus } from '../../domain/wagering/transaction-types';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export interface TransactionView {
  id: string;
  walletId: string;
  playerId: string;
  origin: 'INTERNAL' | 'PROVIDER';
  kind: TransactionKind;
  status: Exclude<TransactionStatus, 'PENDING'>;
  money: MoneyProps;
  providerId?: string;
  externalTransactionId?: string;
  roundId?: string;
  gameId?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  result: { balance: MoneyProps; status: string; failureCode?: string };
  createdAt: string;
  processedAt?: string;
  completedAt?: string;
}
export interface ReconciliationFigures {
  calculatedAmount: string;
  differenceAmount: string;
  checkedEntries: number;
  consistent: boolean;
  issues: string[];
}
export interface FinancialReadSnapshot {
  wallet(id: string): Promise<Wallet | null>;
  ledger(
    walletId: string,
    upperVersion: number,
    beforeVersion: number | undefined,
    limit: number,
  ): Promise<WalletLedgerEntry[]>;
  transaction(id: string): Promise<TransactionView | null>;
  externalTransaction(providerId: string, externalId: string): Promise<TransactionView | null>;
  reconciliation(wallet: Wallet): Promise<ReconciliationFigures>;
}
export interface FinancialReadStore {
  snapshot<T>(read: (snapshot: FinancialReadSnapshot) => Promise<T>): Promise<T>;
}
export interface LedgerCursor {
  walletId: string;
  upperVersion: number;
  lastVersion: number;
}
export interface LedgerCursorPort {
  encode(cursor: LedgerCursor): string;
  decode(value: string, walletId: string): LedgerCursor;
}
export interface QueryDiagnostics {
  reconciliationIssue(walletId: string, issues: readonly string[], correlationId: string): void;
  integrityFailure(correlationId: string): void;
}
