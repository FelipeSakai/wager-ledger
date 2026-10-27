export type FinancialEventType =
  | 'WagerTransactionProcessed'
  | 'WagerTransactionRejected'
  | 'WalletBalanceChanged'
  | 'WagerTransactionPendingReference';

export interface OutboxWrite {
  id: string;
  transactionId: string;
  aggregateId: string;
  eventType: FinancialEventType;
  eventVersion: 1;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}
