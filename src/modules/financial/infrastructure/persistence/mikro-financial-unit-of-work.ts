import { isPostgresUnavailable } from '../../../../platform/database/postgres-unavailable';
import {
  operationTelemetry,
  type FinancialOperationContext,
} from '../../application/ports/financial-telemetry';
import { FlushMode, LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { OutboxWrite } from '../../application/events/outbox-write';
import {
  FinancialError,
  FinancialStorageError,
  PermanentReferenceFailure,
  RolledBackFinancialFailure,
} from '../../application/financial-error';
import { defaultFinancialPolicy, type FinancialPolicy } from '../../application/financial-policy';
import type { FinancialPersistence } from '../../application/ports/financial-persistence';
import {
  report,
  silentTelemetry,
  type FinancialTelemetry,
} from '../../application/ports/financial-telemetry';
import type { FinancialUnitOfWork } from '../../application/ports/financial-unit-of-work';
import type { InboxDelivery } from '../../application/ports/inbox';
import type { FinancialTransactionWrite } from '../../application/transactions/transaction-write';
import type { WagerState } from '../../domain/wagering/wager-state';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { toWager, toWallet } from './mappers';
import { LedgerRecord, OutboxRecord, TransactionRecord, WalletRecord } from './records';

export class MikroFinancialUnitOfWork implements FinancialUnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly telemetry: FinancialTelemetry = silentTelemetry,
  ) {}

  async run<T>(
    work: (persistence: FinancialPersistence) => Promise<T>,
    timeouts: Pick<
      FinancialPolicy,
      'lockTimeoutMilliseconds' | 'statementTimeoutMilliseconds'
    > = defaultFinancialPolicy,
    operationContext: FinancialOperationContext = {},
  ): Promise<T> {
    const telemetry = operationTelemetry(this.telemetry, operationContext);
    if (
      ![timeouts.lockTimeoutMilliseconds, timeouts.statementTimeoutMilliseconds].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new RangeError('Invalid financial timeout');
    const context = this.orm.em.fork({ flushMode: FlushMode.COMMIT });
    let classified: PermanentReferenceFailure | undefined;
    try {
      // The driver's callback transaction always releases its connection, including
      // rollback failure. Unlike MikroORM.transactional, it does not swallow that
      // failure: only the original callback error certifies an acknowledged rollback.
      return await context
        .getConnection()
        .getClient()
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (transaction) => {
          context.setTransactionContext(transaction);
          await context.execute(
            "select set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)",
            [`${timeouts.lockTimeoutMilliseconds}ms`, `${timeouts.statementTimeoutMilliseconds}ms`],
          );
          const persistence = new MikroFinancialPersistence(context, telemetry);
          try {
            const result = await work(persistence);
            await context.flush();
            return result;
          } catch (error: unknown) {
            if (error instanceof PermanentReferenceFailure) classified = error;
            throw error;
          } finally {
            persistence.close();
          }
        });
    } catch (error: unknown) {
      if (classified && error === classified) throw new RolledBackFinancialFailure(classified);
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = error.code;
        const constraint = 'constraint' in error ? error.constraint : undefined;
        if (
          code === '23505' &&
          [
            'wager_transactions_idempotency_key_key',
            'wager_transactions_provider_id_external_transaction_id_key',
            'sqs_inbox_consumer_name_message_id_key',
          ].includes(String(constraint))
        ) {
          throw new FinancialStorageError('IDENTITY_COLLISION');
        }
        if (code === '23505' && constraint === 'wallets_player_id_currency_key')
          throw new FinancialStorageError('WALLET_COLLISION');
        if (['40P01', '40001', '55P03', '57014'].includes(String(code))) {
          if (['40P01', '55P03'].includes(String(code)))
            report(telemetry, { event: 'lock_conflict' });
          throw new FinancialStorageError('TRANSIENT');
        }
      }
      if (isPostgresUnavailable(error)) throw new FinancialStorageError('UNAVAILABLE');
      throw error;
    } finally {
      context.resetTransactionContext();
    }
  }
}

class MikroFinancialPersistence implements FinancialPersistence {
  private active = true;
  private readonly transactions = new Map<string, TransactionRecord>();
  private readonly wallets = new Map<string, WalletRecord>();

  constructor(
    private readonly em: EntityManager,
    private readonly telemetry: FinancialTelemetry,
  ) {}

  close(): void {
    this.active = false;
  }

  private assertActive(): void {
    if (!this.active || !this.em.isInTransaction())
      throw new Error('Financial context is no longer active');
  }

  async transactionCorrelation(transactionId: string): Promise<string | null> {
    this.assertActive();
    const [row] = await this.em.execute<{ correlation: string | null }[]>(
      `select payload->>'correlationId' as correlation
      from financial.outbox_messages where transaction_id=? and event_type='WagerTransactionPendingReference' limit 1`,
      [transactionId],
    );
    return row?.correlation ?? null;
  }
  async hasFinancialEffect(transactionId: string): Promise<boolean> {
    this.assertActive();
    const transaction = this.transactions.get(transactionId);
    if (!transaction || !this.wallets.has(transaction.walletId))
      throw new Error('Effect verification requires the wallet lock');
    const [row] = await this.em.execute<{ present: boolean }[]>(
      `select
      exists(select 1 from financial.wallet_ledger_entries where transaction_id=?) OR
      exists(select 1 from financial.outbox_messages where transaction_id=? and event_type<>'WagerTransactionPendingReference') as present`,
      [transactionId, transactionId],
    );
    return row!.present;
  }
  async setFailureCorrelation(correlationId: string): Promise<void> {
    this.assertActive();
    await this.em.execute("select set_config('wager.failure_correlation_id', ?, true)", [
      correlationId,
    ]);
  }

  async checkInbox(delivery: InboxDelivery): Promise<void> {
    this.assertActive();
    const [row] = await this.em.execute<Record<string, unknown>[]>(
      'select payload_hash from financial.sqs_inbox where consumer_name=? and message_id=?',
      [delivery.consumerName, delivery.messageId],
    );
    if (row && row.payload_hash !== delivery.payloadHash)
      throw new FinancialError('INBOX_PAYLOAD_CONFLICT');
  }
  async recordInbox(delivery: InboxDelivery, transactionId: string): Promise<void> {
    this.assertActive();
    const transaction = await this.em.findOneOrFail(TransactionRecord, transactionId, {
      refresh: true,
    });
    if (!this.wallets.has(transaction.walletId))
      throw new Error('Inbox requires the financial wallet lock');
    await this.checkInbox(delivery);
    const [record] = await this.em.execute<Record<string, unknown>[]>(
      `insert into financial.sqs_inbox
      (id,consumer_name,message_id,payload_hash,hash_version,transaction_id,body,source_queue,transport_message_id,group_id,dlq_queue,disposition)
      values(?,?,?,?,1,?,?,?,?,?,?,'ACK_AFTER_COMMIT')
      on conflict(consumer_name,message_id) do nothing returning id`,
      [
        delivery.id,
        delivery.consumerName,
        delivery.messageId,
        delivery.payloadHash,
        transactionId,
        delivery.body,
        delivery.sourceQueue,
        delivery.transportMessageId,
        delivery.groupId,
        delivery.dlqQueue,
      ],
    );
    await this.checkInbox(delivery);
    const [inbox] = record
      ? [record]
      : await this.em.execute<Record<string, unknown>[]>(
          'select id from financial.sqs_inbox where consumer_name=? and message_id=?',
          [delivery.consumerName, delivery.messageId],
        );
    if (!inbox) throw new Error('Inbox insertion was not durable');
    if (transaction.status === 'PENDING_REFERENCE')
      await this.em.execute(
        `insert into financial.sqs_origins(transaction_id,inbox_id)
      values(?,?) on conflict(transaction_id) do nothing`,
        [transactionId, inbox.id],
      );
    if (transaction.status === 'FAILED')
      await this.em.execute("select financial.ensure_inbox_dlq(?, 'FAILED_TRANSACTION')", [
        inbox.id,
      ]);
  }

  async findWallet(playerId: string, currency: string): Promise<Wallet | null> {
    this.assertActive();
    const record = await this.em.findOne(WalletRecord, { playerId, currency }, { refresh: true });
    return record ? toWallet(record) : null;
  }
  async findByKey(idempotencyKey: string): Promise<WagerState | null> {
    this.assertActive();
    return this.readTransaction(
      await this.em.findOne(TransactionRecord, { idempotencyKey }, { refresh: true }),
    );
  }
  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerState | null> {
    this.assertActive();
    return this.readTransaction(
      await this.em.findOne(
        TransactionRecord,
        { providerId, externalTransactionId },
        { refresh: true },
      ),
    );
  }
  async findWager(id: string): Promise<WagerState | null> {
    this.assertActive();
    return this.readTransaction(await this.em.findOne(TransactionRecord, id, { refresh: true }));
  }
  async hasEffectiveReversal(referenceTransactionId: string): Promise<boolean> {
    this.assertActive();
    return (
      (await this.em.count(TransactionRecord, {
        referenceTransactionId,
        kind: { $in: ['REFUND', 'ROLLBACK'] },
        status: 'PROCESSED',
      })) > 0
    );
  }
  private readTransaction(record: TransactionRecord | null): WagerState | null {
    if (!record) return null;
    this.transactions.set(record.id, record);
    return toWager(record);
  }

  async lockWallet(id: string): Promise<Wallet> {
    this.assertActive();
    const start = performance.now();
    let record: WalletRecord | null;
    try {
      record = await this.em.findOne(WalletRecord, id, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
        refresh: true,
      });
      report(this.telemetry, {
        event: 'wallet_lock',
        outcome: 'success',
        walletId: id,
        durationSeconds: (performance.now() - start) / 1000,
      });
    } catch (error: unknown) {
      report(this.telemetry, {
        event: 'wallet_lock',
        outcome: 'failure',
        walletId: id,
        durationSeconds: (performance.now() - start) / 1000,
      });
      throw error;
    }
    if (!record) throw new FinancialStorageError('WALLET_NOT_FOUND');
    this.wallets.set(record.id, record);
    return toWallet(record);
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    this.assertActive();
    const record = this.em.create(WalletRecord, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
    this.em.persist(record);
    await this.em.flush();
    this.wallets.set(record.id, record);
  }

  async appendMovement(
    entry: WalletLedgerEntry,
    transaction: FinancialTransactionWrite,
    events: readonly OutboxWrite[],
  ): Promise<void> {
    this.assertActive();
    const wallet = this.wallets.get(entry.walletId);
    if (
      !wallet ||
      transaction.walletId.toLowerCase() !== entry.walletId.toLowerCase() ||
      transaction.id !== entry.transactionId
    ) {
      throw new Error('Movement must use the locked wallet and matching transaction');
    }
    if (entry.walletVersion === 1) {
      if (wallet.version !== 1 || wallet.balance !== entry.balanceAfter.toJSON().amount) {
        throw new Error('Opening entry differs from the newly inserted wallet');
      }
    } else {
      if (
        wallet.version !== entry.walletVersion - 1 ||
        wallet.balance !== entry.balanceBefore.toJSON().amount
      ) {
        throw new Error('Movement snapshot does not follow the persisted wallet version');
      }
      wallet.balance = entry.balanceAfter.toJSON().amount;
      wallet.version = entry.walletVersion;
      wallet.updatedAt = entry.createdAt;
    }
    this.persistTransaction(transaction, events);
    this.em.persist(
      this.em.create(LedgerRecord, {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        walletVersion: entry.walletVersion,
        direction: entry.direction,
        currency: entry.money.currency,
        amount: entry.money.toJSON().amount,
        balanceBefore: entry.balanceBefore.toJSON().amount,
        balanceAfter: entry.balanceAfter.toJSON().amount,
        createdAt: entry.createdAt,
      }),
    );
    // Each call emits this movement before accepting the next snapshot. Only the outer unit commits.
    await this.em.flush();
  }

  async recordTransaction(
    transaction: FinancialTransactionWrite,
    events: readonly OutboxWrite[],
  ): Promise<void> {
    this.assertActive();
    if (!this.wallets.has(transaction.walletId.toLowerCase()))
      throw new Error('Transaction requires a locked wallet');
    this.persistTransaction(transaction, events);
    await this.em.flush();
  }

  private persistTransaction(
    transaction: FinancialTransactionWrite,
    events: readonly OutboxWrite[],
  ): void {
    const existing = this.transactions.get(transaction.id);
    if (existing) {
      if (!this.wallets.has(transaction.walletId.toLowerCase()))
        throw new Error('Transaction requires a locked wallet');
      existing.status = transaction.status;
      existing.referenceTransactionId = transaction.referenceTransactionId ?? null;
      existing.failureCode = transaction.failureCode ?? null;
      existing.result = transaction.result ? structuredClone(transaction.result) : null;
      existing.processedAt = transaction.processedAt ?? null;
      existing.completedAt = transaction.completedAt ?? null;
      existing.referenceAttempts = transaction.referenceAttempts ?? 0;
      existing.nextReferenceAttemptAt = transaction.nextReferenceAttemptAt ?? null;
      existing.referenceExpiresAt = transaction.referenceExpiresAt ?? null;
      existing.pendingReason = transaction.pendingReason ?? null;
    } else
      this.em.persist(
        this.em.create(TransactionRecord, {
          id: transaction.id,
          walletId: transaction.walletId,
          playerId: transaction.playerId,
          amount: transaction.money.toJSON().amount,
          currency: transaction.money.currency,
          origin: transaction.origin,
          kind: transaction.kind,
          status: transaction.status,
          internalIdentity: transaction.internalIdentity ?? null,
          providerId: transaction.providerId ?? null,
          externalTransactionId: transaction.externalTransactionId ?? null,
          idempotencyKey: transaction.idempotencyKey ?? null,
          payloadHashVersion:
            transaction.origin === 'PROVIDER' ? (transaction.payloadHashVersion ?? 1) : null,
          referenceAttempts: transaction.referenceAttempts ?? 0,
          nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
          referenceExpiresAt: transaction.referenceExpiresAt ?? null,
          pendingReason: transaction.pendingReason ?? null,
          payloadHash: transaction.payloadHash ?? null,
          roundId: transaction.roundId ?? null,
          gameId: transaction.gameId ?? null,
          referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
          referenceTransactionId: transaction.referenceTransactionId ?? null,
          failureCode: transaction.failureCode ?? null,
          result: transaction.result ? structuredClone(transaction.result) : null,
          createdAt: transaction.createdAt,
          processedAt: transaction.processedAt ?? null,
          completedAt: transaction.completedAt ?? null,
        }),
      );
    for (const event of events) {
      this.em.persist(
        this.em.create(OutboxRecord, {
          id: event.id,
          transactionId: event.transactionId,
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          eventVersion: event.eventVersion,
          payload: structuredClone(event.payload),
          occurredAt: event.occurredAt,
          attempts: 0,
          nextAttemptAt: null,
          publishedAt: null,
          claimToken: null,
          leaseUntil: null,
          suspendedAt: null,
        }),
      );
    }
  }
}
