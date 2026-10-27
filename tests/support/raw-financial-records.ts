import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxWrite } from '../../src/modules/financial/application/events/outbox-write';
import type { FinancialTransactionWrite } from '../../src/modules/financial/application/transactions/transaction-write';
import type { WalletLedgerEntry } from '../../src/modules/financial/domain/wallet/wallet-ledger-entry';

async function insert(
  em: EntityManager,
  table: string,
  data: Record<string, unknown>,
): Promise<void> {
  const columns = Object.keys(data);
  await em.execute(
    `insert into financial.${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    Object.values(data),
  );
}

export async function insertRawLedger(
  em: EntityManager,
  entry: WalletLedgerEntry,
  changes: Record<string, unknown> = {},
): Promise<void> {
  await insert(em, 'wallet_ledger_entries', {
    id: entry.id,
    wallet_id: entry.walletId,
    transaction_id: entry.transactionId,
    wallet_version: entry.walletVersion,
    direction: entry.direction,
    currency: entry.money.currency,
    amount: entry.money.toJSON().amount,
    balance_before: entry.balanceBefore.toJSON().amount,
    balance_after: entry.balanceAfter.toJSON().amount,
    created_at: entry.createdAt,
    ...changes,
  });
}

export async function insertRawFinance(
  em: EntityManager,
  transaction: FinancialTransactionWrite,
  events: readonly OutboxWrite[],
  entry: WalletLedgerEntry,
  changes: Record<string, unknown> = {},
): Promise<void> {
  await insert(em, 'wager_transactions', {
    id: transaction.id,
    wallet_id: transaction.walletId,
    player_id: transaction.playerId,
    currency: transaction.money.currency,
    amount: transaction.money.toJSON().amount,
    origin: transaction.origin,
    kind: transaction.kind,
    status: transaction.status,
    internal_identity: transaction.internalIdentity ?? null,
    provider_id: transaction.providerId ?? null,
    external_transaction_id: transaction.externalTransactionId ?? null,
    idempotency_key: transaction.idempotencyKey ?? null,
    payload_hash_version:
      transaction.origin === 'PROVIDER' ? (transaction.payloadHashVersion ?? 1) : null,
    payload_hash: transaction.payloadHash ?? null,
    round_id: transaction.roundId ?? null,
    game_id: transaction.gameId ?? null,
    reference_external_transaction_id: transaction.referenceExternalTransactionId ?? null,
    reference_transaction_id: transaction.referenceTransactionId ?? null,
    failure_code: transaction.failureCode ?? null,
    result: JSON.stringify(transaction.result),
    created_at: transaction.createdAt,
    processed_at: transaction.processedAt ?? null,
    completed_at: transaction.completedAt ?? null,
  });
  for (const event of events) {
    await insert(em, 'outbox_messages', {
      id: event.id,
      transaction_id: event.transactionId,
      aggregate_id: event.aggregateId,
      event_type: event.eventType,
      event_version: event.eventVersion,
      payload: JSON.stringify(event.payload),
      occurred_at: event.occurredAt,
    });
  }
  await insertRawLedger(em, entry, changes);
}
