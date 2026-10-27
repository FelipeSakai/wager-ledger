import type { Money } from '../../domain/money/money';
import type { TransactionKind, TransactionStatus } from '../../domain/wagering/transaction-types';
import type { PendingReason } from '../../domain/wagering/wager-state';

export interface FinancialTransactionWrite {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  origin: 'INTERNAL' | 'PROVIDER';
  kind: TransactionKind;
  status: TransactionStatus;
  internalIdentity?: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  payloadHash?: string;
  payloadHashVersion?: 1;
  referenceAttempts?: number;
  nextReferenceAttemptAt?: Date;
  referenceExpiresAt?: Date;
  pendingReason?: PendingReason;
  roundId?: string;
  gameId?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  result?: Readonly<Record<string, unknown>>;
  createdAt: Date;
  processedAt?: Date;
  completedAt?: Date;
}
