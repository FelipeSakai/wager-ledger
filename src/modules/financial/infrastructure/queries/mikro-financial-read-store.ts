import { isPostgresUnavailable } from '../../../../platform/database/postgres-unavailable';
import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { FinancialError, FinancialStorageError } from '../../application/financial-error';
import type {
  FinancialReadSnapshot,
  FinancialReadStore,
  ReconciliationFigures,
  TransactionView,
} from '../../application/ports/financial-read-store';
import { Money } from '../../domain/money/money';
import { isRecord, isTimestamp, isUuid } from '../../domain/validation/domain-validation';
import type { Wallet } from '../../domain/wallet/wallet';
import { toLedger, toWager, toWallet } from '../persistence/mappers';
import { LedgerRecord, TransactionRecord, WalletRecord } from '../persistence/records';

export class MikroFinancialReadStore implements FinancialReadStore {
  constructor(private readonly orm: MikroORM) {}
  async snapshot<T>(read: (snapshot: FinancialReadSnapshot) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          await em.execute('set transaction read only');
          await em.execute(
            "select set_config('statement_timeout', '2000ms', true), set_config('lock_timeout', '250ms', true)",
          );
          const snapshot = new MikroFinancialReadSnapshot(em);
          try {
            return await read(snapshot);
          } finally {
            snapshot.close();
          }
        },
        { isolationLevel: IsolationLevel.REPEATABLE_READ },
      );
    } catch (error: unknown) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (['40P01', '40001', '55P03', '57014'].includes(code))
        throw new FinancialStorageError('TRANSIENT');
      if (isPostgresUnavailable(error)) throw new FinancialStorageError('UNAVAILABLE');
      throw error;
    }
  }
}

class MikroFinancialReadSnapshot implements FinancialReadSnapshot {
  private active = true;
  constructor(private readonly em: EntityManager) {}
  close(): void {
    this.active = false;
  }
  private assertActive(): void {
    if (!this.active || !this.em.isInTransaction())
      throw new Error('Read snapshot is no longer active');
  }
  async wallet(id: string) {
    this.assertActive();
    const record = await this.em.findOne(WalletRecord, id);
    return record ? toWallet(record) : null;
  }
  async ledger(
    walletId: string,
    upperVersion: number,
    beforeVersion: number | undefined,
    limit: number,
  ) {
    this.assertActive();
    const records = await this.em.find(
      LedgerRecord,
      {
        walletId,
        walletVersion: {
          $lte: upperVersion,
          ...(beforeVersion !== undefined ? { $lt: beforeVersion } : {}),
        },
      },
      { orderBy: { walletVersion: 'DESC' }, limit },
    );
    return records.map(toLedger);
  }
  async transaction(id: string) {
    this.assertActive();
    const record = await this.em.findOne(TransactionRecord, id);
    return record ? transactionView(record) : null;
  }
  async externalTransaction(providerId: string, externalTransactionId: string) {
    this.assertActive();
    const record = await this.em.findOne(TransactionRecord, { providerId, externalTransactionId });
    return record ? transactionView(record) : null;
  }
  async reconciliation(wallet: Wallet): Promise<ReconciliationFigures> {
    this.assertActive();
    const [row] = await this.em.execute<Record<string, unknown>[]>(
      `
      with totals as (
        select coalesce(sum(case when l.direction='CREDIT' then l.amount else -l.amount end), 0.00::numeric) as calculated,
          count(l.id)::text as entries,
          count(l.id) filter (where l.currency is distinct from w.currency or l.direction is null or l.direction not in ('CREDIT','DEBIT')
            or l.amount::text in ('NaN','Infinity','-Infinity')
            or l.balance_before::text in ('NaN','Infinity','-Infinity') or l.balance_after::text in ('NaN','Infinity','-Infinity')
            or t.id is null or t.wallet_id is distinct from w.id or t.currency is distinct from l.currency
            or t.status is distinct from 'PROCESSED')::text as invalid
        from financial.wallets w left join financial.wallet_ledger_entries l on l.wallet_id=w.id
          left join financial.wager_transactions t on t.id=l.transaction_id
        where w.id=? group by w.id
      )
      select calculated::text, (?::numeric-calculated)::text as difference, entries, invalid,
        abs(calculated)>999999999999999999.99::numeric as calculated_outside,
        abs(?::numeric-calculated)>999999999999999999.99::numeric as difference_outside
      from totals`,
      [wallet.id, wallet.balance.toJSON().amount, wallet.balance.toJSON().amount],
    );
    const signedAmount = /^-?(0|[1-9][0-9]*)\.[0-9]{2}$/;
    if (
      !row ||
      row.invalid !== '0' ||
      typeof row.calculated !== 'string' ||
      typeof row.difference !== 'string' ||
      !signedAmount.test(row.calculated) ||
      !signedAmount.test(row.difference) ||
      typeof row.entries !== 'string' ||
      !/^[0-9]+$/.test(row.entries)
    )
      throw new FinancialError('INVALID_PERSISTED_DATA');
    const checkedEntries = Number(row.entries);
    if (!Number.isSafeInteger(checkedEntries)) throw new FinancialError('INVALID_PERSISTED_DATA');
    const issues: string[] = [];
    if (row.calculated_outside) issues.push('CALCULATED_BALANCE_OUT_OF_RANGE');
    if (row.difference_outside) issues.push('DIFFERENCE_OUT_OF_RANGE');
    if (row.difference !== '0.00') issues.push('BALANCE_MISMATCH');
    return {
      calculatedAmount: row.calculated,
      differenceAmount: row.difference,
      checkedEntries,
      consistent: issues.length === 0,
      issues,
    };
  }
}

function transactionView(record: TransactionRecord): TransactionView {
  if (record.currency !== 'BRL') throw new FinancialError('INVALID_PERSISTED_DATA');
  if (record.origin === 'PROVIDER') {
    const state = toWager(record);
    if (
      !state.result ||
      state.status === 'PENDING' ||
      (record.failureCode ?? undefined) !== state.result.failureCode
    )
      throw new FinancialError('INVALID_PERSISTED_DATA');
    return {
      id: state.id,
      ...state.command,
      money: state.command.money.toJSON(),
      origin: 'PROVIDER',
      status: state.status,
      referenceTransactionId: state.referenceTransactionId,
      failureCode: state.result.failureCode,
      result: {
        balance: state.result.balance,
        status: state.result.status,
        ...(state.result.failureCode ? { failureCode: state.result.failureCode } : {}),
      },
      createdAt: state.createdAt.toISOString(),
      processedAt: state.processedAt?.toISOString(),
      completedAt: state.completedAt?.toISOString(),
    };
  }
  if (
    record.origin !== 'INTERNAL' ||
    record.kind !== 'OPENING' ||
    record.status !== 'PROCESSED' ||
    !isUuid(record.id) ||
    !isUuid(record.walletId) ||
    !isUuid(record.playerId) ||
    record.internalIdentity !== `opening:${record.walletId}` ||
    record.providerId !== null ||
    record.externalTransactionId !== null ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.processedAt) ||
    !isTimestamp(record.completedAt) ||
    !isRecord(record.result) ||
    record.result.status !== record.status ||
    record.result.transactionId !== record.id ||
    !isRecord(record.result.balance)
  )
    throw new FinancialError('INVALID_PERSISTED_DATA');
  const money = Money.rehydrate({ amount: record.amount, currency: record.currency });
  const balance = Money.rehydrate(
    record.result.balance as unknown as { amount: string; currency: string },
  );
  if (!money.isPositive() || !money.equals(balance))
    throw new FinancialError('INVALID_PERSISTED_DATA');
  return {
    id: record.id,
    walletId: record.walletId,
    playerId: record.playerId,
    origin: 'INTERNAL',
    kind: 'OPENING',
    status: 'PROCESSED',
    money: money.toJSON(),
    result: { balance: balance.toJSON(), status: 'PROCESSED' },
    createdAt: record.createdAt.toISOString(),
    processedAt: record.processedAt.toISOString(),
    completedAt: record.completedAt.toISOString(),
  };
}
