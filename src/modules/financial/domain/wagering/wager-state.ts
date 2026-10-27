import type { Money, MoneyProps } from '../money/money';
import type { ExternalTransactionKind, WagerStatus } from './transaction-types';

export interface WagerCommand {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: ExternalTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}
export interface WagerResult {
  transactionId: string;
  status: Exclude<WagerStatus, 'PENDING'>;
  failureCode?: string;
  balance: MoneyProps;
}
export type PendingReason = 'REFERENCE_NOT_FOUND' | 'REFERENCE_NOT_READY';
export interface WagerState {
  id: string;
  command: WagerCommand;
  idempotencyKey: string;
  payloadHash: string;
  payloadHashVersion: 1;
  status: WagerStatus;
  result?: WagerResult;
  referenceTransactionId?: string;
  createdAt: Date;
  processedAt?: Date;
  completedAt?: Date;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
  referenceExpiresAt?: Date;
  pendingReason?: PendingReason;
}
