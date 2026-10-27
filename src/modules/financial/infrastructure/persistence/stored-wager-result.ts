import { isRecord } from '../../domain/validation/domain-validation';
import type { WagerResult } from '../../domain/wagering/wager-state';
import { WagerTransactionError } from '../../domain/wagering/wager-transaction-error';

// Old immutable results contained a transport-specific field. Read and validate it
// here, but never leak it into the business state or rewrite historical records.
export function storedWagerResult(value: unknown): WagerResult | undefined {
  if (value === null) return undefined;
  if (!isRecord(value)) throw new WagerTransactionError('INVALID_PERSISTED_TRANSACTION');
  if ('httpStatus' in value) {
    const legacyStatuses: Record<string, number> = {
      PROCESSED: 200,
      PENDING_REFERENCE: 202,
      REJECTED: 422,
      FAILED: 500,
    };
    if (
      typeof value.status !== 'string' ||
      !Object.hasOwn(legacyStatuses, value.status) ||
      value.httpStatus !== legacyStatuses[value.status]
    )
      throw new WagerTransactionError('INVALID_PERSISTED_TRANSACTION');
  }
  return {
    transactionId: value.transactionId,
    status: value.status,
    balance: structuredClone(value.balance),
    ...(value.failureCode !== undefined ? { failureCode: value.failureCode } : {}),
  } as WagerResult;
}
