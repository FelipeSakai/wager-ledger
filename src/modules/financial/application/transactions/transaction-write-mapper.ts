import type { WagerState } from '../../domain/wagering/wager-state';
import type { FinancialTransactionWrite } from './transaction-write';

export function transactionWrite(state: WagerState): FinancialTransactionWrite {
  return {
    ...state.command,
    id: state.id,
    origin: 'PROVIDER',
    status: state.status,
    idempotencyKey: state.idempotencyKey,
    payloadHash: state.payloadHash,
    payloadHashVersion: state.payloadHashVersion,
    referenceTransactionId: state.referenceTransactionId,
    failureCode: state.result?.failureCode,
    result: state.result ? { ...state.result } : undefined,
    createdAt: state.createdAt,
    processedAt: state.processedAt,
    completedAt: state.completedAt,
    referenceAttempts: state.referenceAttempts,
    nextReferenceAttemptAt: state.nextReferenceAttemptAt,
    referenceExpiresAt: state.referenceExpiresAt,
    pendingReason: state.pendingReason,
  };
}
