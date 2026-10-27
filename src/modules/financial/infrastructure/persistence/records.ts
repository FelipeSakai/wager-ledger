import { BigIntType, DecimalType, EntitySchema } from '@mikro-orm/core';
import type { FinancialEventType } from '../../application/events/outbox-write';
import type { TransactionKind, TransactionStatus } from '../../domain/wagering/transaction-types';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class TransactionRecord {
  id!: string;
  walletId!: string;
  playerId!: string;
  currency!: string;
  amount!: string;
  origin!: 'INTERNAL' | 'PROVIDER';
  kind!: TransactionKind;
  status!: TransactionStatus;
  internalIdentity!: string | null;
  providerId!: string | null;
  externalTransactionId!: string | null;
  idempotencyKey!: string | null;
  payloadHash!: string | null;
  payloadHashVersion!: number | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
  referenceExpiresAt!: Date | null;
  pendingReason!: string | null;
  roundId!: string | null;
  gameId!: string | null;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  failureCode!: string | null;
  result!: Record<string, unknown> | null;
  createdAt!: Date;
  processedAt!: Date | null;
  completedAt!: Date | null;
}

export class LedgerRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  walletVersion!: number;
  direction!: string;
  currency!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export class OutboxRecord {
  id!: string;
  transactionId!: string;
  aggregateId!: string;
  eventType!: FinancialEventType;
  eventVersion!: number;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
  claimToken!: string | null;
  leaseUntil!: Date | null;
  suspendedAt!: Date | null;
}

const uuid = () => ({ type: 'uuid' });
const text = (nullable = false) => ({ type: 'text', nullable });
const decimal = () => ({ type: new DecimalType('string'), precision: 20, scale: 2 });
const version = () => ({ type: new BigIntType('number') });
const timestamp = (nullable = false) => ({ type: Date, columnType: 'timestamptz', nullable });

export const walletSchema = new EntitySchema({
  class: WalletRecord,
  tableName: 'wallets',
  schema: 'financial',
  properties: {
    id: { ...uuid(), primary: true },
    playerId: { ...uuid(), fieldName: 'player_id' },
    currency: text(),
    balance: decimal(),
    version: version(),
    createdAt: { ...timestamp(), fieldName: 'created_at' },
    updatedAt: { ...timestamp(), fieldName: 'updated_at' },
  },
});

export const transactionSchema = new EntitySchema({
  class: TransactionRecord,
  tableName: 'wager_transactions',
  schema: 'financial',
  properties: {
    id: { ...uuid(), primary: true },
    walletId: { ...uuid(), fieldName: 'wallet_id' },
    playerId: { ...uuid(), fieldName: 'player_id' },
    currency: text(),
    amount: decimal(),
    origin: text(),
    kind: text(),
    status: text(),
    internalIdentity: { ...text(true), fieldName: 'internal_identity' },
    providerId: { ...text(true), fieldName: 'provider_id' },
    externalTransactionId: { ...text(true), fieldName: 'external_transaction_id' },
    idempotencyKey: { ...text(true), fieldName: 'idempotency_key' },
    payloadHash: { ...text(true), fieldName: 'payload_hash' },
    payloadHashVersion: { type: 'integer', nullable: true, fieldName: 'payload_hash_version' },
    referenceAttempts: { type: 'integer', default: 0, fieldName: 'reference_attempts' },
    nextReferenceAttemptAt: { ...timestamp(true), fieldName: 'next_reference_attempt_at' },
    referenceExpiresAt: { ...timestamp(true), fieldName: 'reference_expires_at' },
    pendingReason: { ...text(true), fieldName: 'pending_reason' },
    roundId: { ...text(true), fieldName: 'round_id' },
    gameId: { ...text(true), fieldName: 'game_id' },
    referenceExternalTransactionId: {
      ...text(true),
      fieldName: 'reference_external_transaction_id',
    },
    referenceTransactionId: { ...uuid(), nullable: true, fieldName: 'reference_transaction_id' },
    failureCode: { ...text(true), fieldName: 'failure_code' },
    result: { type: 'json', columnType: 'jsonb', nullable: true },
    createdAt: { ...timestamp(), fieldName: 'created_at' },
    processedAt: { ...timestamp(true), fieldName: 'processed_at' },
    completedAt: { ...timestamp(true), fieldName: 'completed_at' },
  },
});

export const ledgerSchema = new EntitySchema({
  class: LedgerRecord,
  tableName: 'wallet_ledger_entries',
  schema: 'financial',
  properties: {
    id: { ...uuid(), primary: true },
    walletId: { ...uuid(), fieldName: 'wallet_id' },
    transactionId: { ...uuid(), fieldName: 'transaction_id' },
    walletVersion: { ...version(), fieldName: 'wallet_version' },
    direction: text(),
    currency: text(),
    amount: decimal(),
    balanceBefore: { ...decimal(), fieldName: 'balance_before' },
    balanceAfter: { ...decimal(), fieldName: 'balance_after' },
    createdAt: { ...timestamp(), fieldName: 'created_at' },
  },
});

export const outboxSchema = new EntitySchema({
  class: OutboxRecord,
  tableName: 'outbox_messages',
  schema: 'financial',
  properties: {
    id: { ...uuid(), primary: true },
    transactionId: { ...uuid(), fieldName: 'transaction_id' },
    aggregateId: { ...uuid(), fieldName: 'aggregate_id' },
    eventType: { ...text(), fieldName: 'event_type' },
    eventVersion: { type: 'integer', fieldName: 'event_version' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { ...timestamp(), fieldName: 'occurred_at' },
    attempts: { type: 'integer', default: 0 },
    nextAttemptAt: { ...timestamp(true), fieldName: 'next_attempt_at' },
    publishedAt: { ...timestamp(true), fieldName: 'published_at' },
    claimToken: { ...uuid(), nullable: true, fieldName: 'claim_token' },
    leaseUntil: { ...timestamp(true), fieldName: 'lease_until' },
    suspendedAt: { ...timestamp(true), fieldName: 'suspended_at' },
  },
});

export const financialSchemas = [walletSchema, transactionSchema, ledgerSchema, outboxSchema];
