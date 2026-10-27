import { Money } from '../../domain/money/money';
import {
  isRecord,
  isTimestamp,
  isUuid,
  isWalletVersion,
} from '../../domain/validation/domain-validation';
import type { OutboxClaim } from '../ports/financial-outbox-store';

export class InvalidOutboxEnvelope extends Error {
  constructor() {
    super('Persisted event envelope is invalid');
    this.name = 'InvalidOutboxEnvelope';
  }
}
export function serializeOutboxEnvelope(claim: OutboxClaim): string {
  const payload = claim.payload;
  const recordedAt = new Date(claim.occurredAt);
  if (!isTimestamp(recordedAt)) throw new InvalidOutboxEnvelope();
  const invalid = () => {
    throw new InvalidOutboxEnvelope();
  };
  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    payload.eventId !== claim.id ||
    payload.aggregateId !== claim.aggregateId ||
    payload.eventType !== claim.eventType ||
    payload.version !== 1 ||
    claim.eventVersion !== 1 ||
    !isUuid(payload.eventId) ||
    !isUuid(payload.aggregateId) ||
    !isUuid(payload.correlationId) ||
    (payload.causationId !== undefined && !isUuid(payload.causationId)) ||
    !iso(payload.occurredAt) ||
    recordedAt.toISOString() !== payload.occurredAt ||
    payload.data.walletId !== claim.aggregateId ||
    payload.data.transactionId !== claim.transactionId ||
    !isUuid(claim.transactionId)
  )
    return invalid();
  const data = payload.data;
  const monetary = (value: unknown): boolean => {
    if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'amount,currency') return false;
    try {
      const parsed = Money.from(value as unknown as { amount: string; currency: string });
      return parsed.currency === 'BRL';
    } catch {
      return false;
    }
  };
  const text = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.trim() === value;
  if (claim.eventType === 'WagerTransactionProcessed') {
    if (
      !isUuid(data.playerId) ||
      !['INTERNAL', 'PROVIDER'].includes(String(data.origin)) ||
      !['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(String(data.kind)) ||
      !monetary(data.money) ||
      !monetary(data.balance) ||
      !iso(data.processedAt) ||
      (data.origin === 'INTERNAL'
        ? data.kind !== 'OPENING' ||
          data.providerId !== undefined ||
          data.externalTransactionId !== undefined
        : data.kind === 'OPENING' || !text(data.providerId) || !text(data.externalTransactionId))
    )
      return invalid();
  } else if (claim.eventType === 'WalletBalanceChanged') {
    if (
      !['CREDIT', 'DEBIT'].includes(String(data.direction)) ||
      !isWalletVersion(data.walletVersion) ||
      !monetary(data.money) ||
      !monetary(data.balanceBefore) ||
      !monetary(data.balanceAfter)
    )
      return invalid();
  } else if (claim.eventType === 'WagerTransactionRejected') {
    if (
      data.origin !== 'PROVIDER' ||
      !['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(String(data.kind)) ||
      !text(data.failureCode) ||
      !iso(data.rejectedAt)
    )
      return invalid();
  } else if (claim.eventType === 'WagerTransactionPendingReference') {
    if (
      !text(data.providerId) ||
      !text(data.referenceExternalTransactionId) ||
      !['REFERENCE_NOT_FOUND', 'REFERENCE_NOT_READY'].includes(String(data.reason)) ||
      !iso(data.pendingAt)
    )
      return invalid();
  } else return invalid();
  return JSON.stringify(payload);
}
function iso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return isTimestamp(date) && date.toISOString() === value;
}
