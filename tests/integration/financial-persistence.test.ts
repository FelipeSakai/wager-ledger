import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createOrm } from '../../src/bootstrap/financial-database';
import type { FinancialPersistence } from '../../src/modules/financial/application/ports/financial-persistence';
import { Wallet } from '../../src/modules/financial/domain/wallet/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../src/modules/financial/domain/wallet/wallet-ledger-entry';
import { toLedger, toWallet } from '../../src/modules/financial/infrastructure/persistence/mappers';
import { MikroFinancialUnitOfWork } from '../../src/modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import {
  LedgerRecord,
  WalletRecord,
} from '../../src/modules/financial/infrastructure/persistence/records';
import {
  at,
  eventsFor,
  money,
  move,
  processedTransaction,
  seedWallet,
} from '../support/financial-fixtures';
import { launchRaceWorker } from '../support/race-process';
import { insertRawFinance, insertRawLedger } from '../support/raw-financial-records';

type Orm = Awaited<ReturnType<typeof createOrm>>;
const databaseName = `wager_test_${randomUUID().replaceAll('-', '')}`;
let admin: Orm;
let owner: Orm;
let app: Orm;
let observer: Orm;
let unit: MikroFinancialUnitOfWork;
let appDatabaseUrl: string;
let created = false;

function inDatabase(raw: string): string {
  const url = new URL(raw);
  url.pathname = databaseName;
  return url.href;
}

async function sql(query: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return app.em.fork().execute(query, params);
}

async function assertBalance(walletId: string, amount: string, version: number): Promise<void> {
  const record = await observer.em.fork().findOneOrFail(WalletRecord, walletId);
  const wallet = toWallet(record);
  expect(typeof record.balance).toBe('string');
  expect(wallet.balance.toJSON().amount).toBe(amount);
  expect(wallet.version).toBe(version);
  const [row] = await sql(
    `select w.balance = coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0) as consistent
    from financial.wallets w left join financial.wallet_ledger_entries l on l.wallet_id = w.id
    where w.id = ? group by w.id`,
    [walletId],
  );
  expect(row?.consistent).toBe(true);
}

async function countRows(table: string, walletId: string): Promise<number> {
  if (!['wager_transactions', 'wallet_ledger_entries', 'outbox_messages'].includes(table))
    throw new Error('Unexpected test table');
  const key = table === 'outbox_messages' ? 'aggregate_id' : 'wallet_id';
  const [row] = await sql(
    `select count(*)::integer as count from financial.${table} where ${key} = ?`,
    [walletId],
  );
  return row?.count as number;
}

async function expectDatabaseError(action: () => Promise<unknown>, code?: string): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeDefined();
  if (code) expect(caught).toMatchObject({ code });
}

beforeAll(async () => {
  admin = await createOrm(
    process.env.TEST_DATABASE_ADMIN_URL ??
      'postgresql://wager_admin:wager_admin_local@127.0.0.1:55439/postgres',
  );
  await admin.em.fork().execute(`create database "${databaseName}" owner wager_migrator`);
  created = true;
  owner = await createOrm(
    inDatabase(
      process.env.MIGRATION_DATABASE_URL ??
        'postgresql://wager_migrator:wager_migrator_local@127.0.0.1:55439/wager_ledger',
    ),
  );
  await owner.migrator.up();
  await owner.migrator.down();
  await owner.migrator.up();
  const appUrl = inDatabase(
    process.env.DATABASE_URL ??
      'postgresql://wager_app:wager_app_local@127.0.0.1:55439/wager_ledger',
  );
  appDatabaseUrl = appUrl;
  app = await createOrm(appUrl);
  observer = await createOrm(appUrl);
  unit = new MikroFinancialUnitOfWork(app);
}, 30000);

afterAll(async () => {
  if (observer) await observer.close(true);
  if (app) await app.close(true);
  if (owner) await owner.close(true);
  if (admin) {
    if (created) await admin.em.fork().execute(`drop database "${databaseName}" with (force)`);
    await admin.close(true);
  }
}, 30000);

describe('PostgreSQL + MikroORM — financial persistence', () => {
  test('migrations up/down/up run against an isolated database', async () => {
    expect(await owner.migrator.getExecuted()).toHaveLength(5);
    const rows = await sql(
      `select table_name from information_schema.tables where table_schema = 'financial'`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      'dlq_resume_audit',
      'dlq_transfers',
      'failure_diagnostics',
      'outbox_messages',
      'outbox_resume_audit',
      'sqs_inbox',
      'sqs_origins',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);
  });

  test('WAL-001: zero opening has no transaction, ledger or event', async () => {
    const wallet = await seedWallet(unit, '0.00');
    await assertBalance(wallet.id, '0.00', 1);
    for (const table of ['wager_transactions', 'wallet_ledger_entries', 'outbox_messages']) {
      expect(await countRows(table, wallet.id)).toBe(0);
    }
  });

  test('WAL-002 / WAL-003 / WAL-033 / WAL-034: positive opening and its two outbox facts commit together', async () => {
    const wallet = await seedWallet(unit);
    await assertBalance(wallet.id, '100.00', 1);
    expect(await countRows('wager_transactions', wallet.id)).toBe(1);
    expect(await countRows('wallet_ledger_entries', wallet.id)).toBe(1);
    expect(await countRows('outbox_messages', wallet.id)).toBe(2);
    const [transaction] = await sql(
      'select origin, internal_identity, provider_id, game_id, round_id from financial.wager_transactions where wallet_id = ?',
      [wallet.id],
    );
    expect(transaction).toEqual({
      origin: 'INTERNAL',
      internal_identity: `opening:${wallet.id}`,
      provider_id: null,
      game_id: null,
      round_id: null,
    });
  });

  test('WAL-038: two movements emit two versions inside one commit even when final balance is unchanged', async () => {
    const seeded = await seedWallet(unit);
    await unit.run(async (tx) => {
      const wallet = await tx.lockWallet(seeded.id);
      const debit = move(wallet, 'debit', '25.00');
      const first = processedTransaction(wallet, debit, 'BET');
      await tx.appendMovement(debit, first, eventsFor(first, debit));
      await assertBalance(wallet.id, '100.00', 1);
      const credit = move(wallet, 'credit', '25.00');
      const second = processedTransaction(wallet, credit, 'WIN');
      await tx.appendMovement(credit, second, eventsFor(second, credit));
      await assertBalance(wallet.id, '100.00', 1);
    });
    await assertBalance(seeded.id, '100.00', 3);
    expect(await countRows('wallet_ledger_entries', seeded.id)).toBe(3);
    expect(await countRows('outbox_messages', seeded.id)).toBe(6);
  });

  test('WAL-039: failure after an intermediate flush rolls back every financial write', async () => {
    const seeded = await seedWallet(unit);
    await expect(
      unit.run(async (tx) => {
        const wallet = await tx.lockWallet(seeded.id);
        const entry = move(wallet, 'debit', '25.00');
        const transaction = processedTransaction(wallet, entry, 'BET');
        await tx.appendMovement(entry, transaction, eventsFor(transaction, entry));
        throw new Error('Injected failure after flush');
      }),
    ).rejects.toThrow('Injected failure');
    await assertBalance(seeded.id, '100.00', 1);
    expect(await countRows('wager_transactions', seeded.id)).toBe(1);
    expect(await countRows('wallet_ledger_entries', seeded.id)).toBe(1);
    expect(await countRows('outbox_messages', seeded.id)).toBe(2);
  });

  test('WAL-040: creation and a following movement preserve both images in the same transaction', async () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: money('100.00'),
      at: at(),
    });
    await unit.run(async (tx) => {
      await tx.insertWallet(wallet);
      const opening = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: randomUUID(),
        walletVersion: 1,
        direction: LedgerDirection.Credit,
        money: wallet.balance,
        balanceBefore: money('0.00'),
        balanceAfter: wallet.balance,
        createdAt: at(),
      });
      const initial = processedTransaction(wallet, opening, 'OPENING');
      await tx.appendMovement(opening, initial, eventsFor(initial, opening));
      const entry = move(wallet, 'debit', '25.00');
      const transaction = processedTransaction(wallet, entry, 'BET');
      await tx.appendMovement(entry, transaction, eventsFor(transaction, entry));
      expect(await observer.em.fork().findOne(WalletRecord, wallet.id)).toBeNull();
    });
    await assertBalance(wallet.id, '75.00', 2);
  });

  test('WAL-013 / WAL-029: numeric strings round-trip near MAX with no loss of cents', async () => {
    const wallet = await seedWallet(unit, '999999999999999999.99');
    await unit.run(async (tx) => {
      const current = await tx.lockWallet(wallet.id);
      const entry = move(current, 'debit', '0.01');
      const transaction = processedTransaction(current, entry, 'BET');
      await tx.appendMovement(entry, transaction, eventsFor(transaction, entry));
    });
    await assertBalance(wallet.id, '999999999999999999.98', 2);
    const record = await observer.em
      .fork()
      .findOneOrFail(LedgerRecord, { walletId: wallet.id, walletVersion: 2 });
    expect(typeof record.amount).toBe('string');
    expect(toLedger(record).balanceAfter.toJSON().amount).toBe('999999999999999999.98');
  });

  test('WAL-026: first movement after zero opening uses ledger version two', async () => {
    const wallet = await seedWallet(unit, '0.00');
    await unit.run(async (tx) => {
      const current = await tx.lockWallet(wallet.id);
      const entry = move(current, 'credit', '10.00');
      const transaction = processedTransaction(current, entry, 'WIN');
      await tx.appendMovement(entry, transaction, eventsFor(transaction, entry));
    });
    await assertBalance(wallet.id, '10.00', 2);
    expect(await countRows('wallet_ledger_entries', wallet.id)).toBe(1);
  });

  test('WAL-021: a direct SQL balance update without a ledger fails at commit', async () => {
    const wallet = await seedWallet(unit);
    await expectDatabaseError(
      () =>
        sql('update financial.wallets set balance = ?, version = version + 1 where id = ?', [
          '75.00',
          wallet.id,
        ]),
      '23514',
    );
    await assertBalance(wallet.id, '100.00', 1);
  });

  test('WAL-031: restoring the initial balance cannot hide an omitted intermediate ledger', async () => {
    const wallet = await seedWallet(unit);
    await expectDatabaseError(
      () =>
        app.em.fork().transactional(async (em) => {
          await em.execute(
            'update financial.wallets set balance = ?, version = version + 1 where id = ?',
            ['75.00', wallet.id],
          );
          await em.execute(
            'update financial.wallets set balance = ?, version = version + 1 where id = ?',
            ['100.00', wallet.id],
          );
        }),
      '23514',
    );
    await assertBalance(wallet.id, '100.00', 1);
  });

  test('WAL-027: collapsed or skipped financial versions are rejected', async () => {
    const wallet = await seedWallet(unit);
    await expectDatabaseError(
      () =>
        sql('update financial.wallets set balance = ?, version = version + 2 where id = ?', [
          '75.00',
          wallet.id,
        ]),
      '23514',
    );
    await assertBalance(wallet.id, '100.00', 1);
  });

  test.each(['-0.01', 'NaN', 'Infinity', '1000000000000000000.00'])(
    'WAL-020: raw SQL rejects balance %s',
    async (amount) => {
      const wallet = await seedWallet(unit);
      await expectDatabaseError(() =>
        sql('update financial.wallets set balance = ?, version = version + 1 where id = ?', [
          amount,
          wallet.id,
        ]),
      );
      await assertBalance(wallet.id, '100.00', 1);
    },
  );

  test.each([
    'update financial.wallet_ledger_entries set amount = amount where wallet_id = ?',
    'delete from financial.wallet_ledger_entries where wallet_id = ?',
  ])('WAL-019: application cannot rewrite ledger history', async (query) => {
    const wallet = await seedWallet(unit);
    await expectDatabaseError(() => sql(query, [wallet.id]), '42501');
    await assertBalance(wallet.id, '100.00', 1);
  });

  test('WAL-019: application cannot truncate the ledger or disable its triggers', async () => {
    await expectDatabaseError(() => sql('truncate financial.wallet_ledger_entries'), '42501');
    await expectDatabaseError(
      () => sql('alter table financial.wallet_ledger_entries disable trigger all'),
      '42501',
    );
    const [role] = await sql(
      'select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = current_user',
    );
    expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  });

  test('WAL-004 / WAL-005: concurrent openings of the same player/currency have one winner', async () => {
    const playerId = randomUUID();
    const wallets = [0, 1].map(() =>
      Wallet.open({ id: randomUUID(), playerId, initialBalance: money('0.00'), at: at() }),
    );
    const results = await Promise.allSettled(
      wallets.map((wallet) => unit.run((tx) => tx.insertWallet(wallet))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const rows = await sql('select id from financial.wallets where player_id = ?', [playerId]);
    expect(rows).toHaveLength(1);
  });

  test('WAL-023: missing outbox prevents the entire movement from committing', async () => {
    const wallet = await seedWallet(unit);
    await expectDatabaseError(
      () =>
        unit.run(async (tx) => {
          const current = await tx.lockWallet(wallet.id);
          const entry = move(current, 'debit', '25.00');
          await tx.appendMovement(entry, processedTransaction(current, entry, 'BET'), []);
        }),
      '23514',
    );
    await assertBalance(wallet.id, '100.00', 1);
    expect(await countRows('wager_transactions', wallet.id)).toBe(1);
  });

  test('immutable outbox facts and terminal transaction results are protected', async () => {
    const wallet = await seedWallet(unit);
    await expectDatabaseError(
      () =>
        sql(`update financial.outbox_messages set payload = '{}'::jsonb where aggregate_id = ?`, [
          wallet.id,
        ]),
      '42501',
    );
    await expectDatabaseError(
      () =>
        sql(`update financial.wager_transactions set result = '{}'::jsonb where wallet_id = ?`, [
          wallet.id,
        ]),
      '23514',
    );
    await expectDatabaseError(
      () =>
        sql(
          `update financial.wager_transactions set status = 'PENDING', processed_at = null, completed_at = null where wallet_id = ?`,
          [wallet.id],
        ),
      '23514',
    );
    await assertBalance(wallet.id, '100.00', 1);
  });

  test('a financial context cannot be reused after its transaction ends', async () => {
    let escaped: FinancialPersistence | undefined;
    await unit.run(async (tx) => {
      escaped = tx;
    });
    await expect(escaped!.lockWallet(randomUUID())).rejects.toThrow('no longer active');
  });

  test('WAL-022: a valid ledger cannot commit without its wallet movement', async () => {
    const wallet = await seedWallet(unit);
    const entry = move(wallet, 'debit', '25.00');
    const transaction = processedTransaction(wallet, entry, 'BET');
    await expectDatabaseError(
      () =>
        app.em
          .fork()
          .transactional((em) =>
            insertRawFinance(em, transaction, eventsFor(transaction, entry), entry),
          ),
      '23514',
    );
    await assertBalance(wallet.id, '100.00', 1);
    expect(await countRows('wager_transactions', wallet.id)).toBe(1);
  });

  test('WAL-017: raw SQL cannot bypass ledger arithmetic', async () => {
    const wallet = await seedWallet(unit);
    const entry = move(wallet, 'debit', '25.00');
    const transaction = processedTransaction(wallet, entry, 'BET');
    await expectDatabaseError(
      () =>
        app.em.fork().transactional((em) =>
          insertRawFinance(em, transaction, eventsFor(transaction, entry), entry, {
            balance_after: '75.01',
          }),
        ),
      '23514',
    );
    await assertBalance(wallet.id, '100.00', 1);
  });

  test('WAL-018: two entries for the same wallet/transaction are refused', async () => {
    const wallet = await seedWallet(unit);
    const entry = move(wallet, 'debit', '25.00');
    const transaction = processedTransaction(wallet, entry, 'BET');
    await expectDatabaseError(
      () =>
        app.em.fork().transactional(async (em) => {
          await em.execute(
            'update financial.wallets set balance = ?, version = version + 1 where id = ?',
            ['75.00', wallet.id],
          );
          await insertRawFinance(em, transaction, eventsFor(transaction, entry), entry);
          await insertRawLedger(em, entry, { id: randomUUID(), wallet_version: 3 });
        }),
      '23505',
    );
    await assertBalance(wallet.id, '100.00', 1);
  });

  test('WAL-027: different transactions cannot reuse the same financial version', async () => {
    const wallet = await seedWallet(unit);
    const entry = move(wallet, 'debit', '25.00');
    const second = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: randomUUID(),
      walletVersion: 2,
      direction: entry.direction,
      money: entry.money,
      balanceBefore: entry.balanceBefore,
      balanceAfter: entry.balanceAfter,
      createdAt: at(),
    });
    const firstTx = processedTransaction(wallet, entry, 'BET');
    const secondTx = processedTransaction(wallet, second, 'BET');
    await expectDatabaseError(
      () =>
        app.em.fork().transactional(async (em) => {
          await em.execute(
            'update financial.wallets set balance = ?, version = version + 1 where id = ?',
            ['75.00', wallet.id],
          );
          await insertRawFinance(em, firstTx, eventsFor(firstTx, entry), entry);
          await insertRawFinance(em, secondTx, eventsFor(secondTx, second), second);
        }),
      '23505',
    );
    await assertBalance(wallet.id, '100.00', 1);
  });

  test('WAL-032: a historical opening cannot be inserted below a zero-opening chain', async () => {
    const wallet = await seedWallet(unit, '0.00');
    await unit.run(async (tx) => {
      const current = await tx.lockWallet(wallet.id);
      const entry = move(current, 'credit', '10.00');
      const transaction = processedTransaction(current, entry, 'WIN');
      await tx.appendMovement(entry, transaction, eventsFor(transaction, entry));
    });
    const historical = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: randomUUID(),
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: money('1.00'),
      balanceBefore: money('0.00'),
      balanceAfter: money('1.00'),
      createdAt: at(),
    });
    const transaction = processedTransaction(wallet, historical, 'OPENING');
    await expectDatabaseError(
      () =>
        app.em
          .fork()
          .transactional((em) =>
            insertRawFinance(em, transaction, eventsFor(transaction, historical), historical),
          ),
      '23514',
    );
    await assertBalance(wallet.id, '10.00', 2);
  });

  test('WAL-035: a second opening cannot create another initial credit', async () => {
    const wallet = await seedWallet(unit);
    const entry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: randomUUID(),
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: wallet.balance,
      balanceBefore: money('0.00'),
      balanceAfter: wallet.balance,
      createdAt: at(),
    });
    const transaction = processedTransaction(wallet, entry, 'OPENING');
    await expectDatabaseError(
      () =>
        unit.run(async (tx) => {
          await tx.lockWallet(wallet.id);
          await tx.appendMovement(entry, transaction, eventsFor(transaction, entry));
        }),
      '23505',
    );
    await assertBalance(wallet.id, '100.00', 1);
    expect(await countRows('wallet_ledger_entries', wallet.id)).toBe(1);
  });

  test('WAL-023: positive wallet creation without its financial records rolls back', async () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: money('100.00'),
      at: at(),
    });
    await expectDatabaseError(() => unit.run((tx) => tx.insertWallet(wallet)), '23514');
    expect(await observer.em.fork().findOne(WalletRecord, wallet.id)).toBeNull();
  });

  test('processed transaction player/context must agree with its wallet', async () => {
    const wallet = await seedWallet(unit);
    await expectDatabaseError(
      () =>
        unit.run(async (tx) => {
          const current = await tx.lockWallet(wallet.id);
          const entry = move(current, 'debit', '25.00');
          const transaction = processedTransaction(current, entry, 'BET', {
            playerId: randomUUID(),
          });
          await tx.appendMovement(entry, transaction, eventsFor(transaction, entry));
        }),
      '23514',
    );
    await assertBalance(wallet.id, '100.00', 1);
  });

  test('a context-mismatch rejection remains auditable without a ledger', async () => {
    const wallet = await seedWallet(unit);
    const sample = move(wallet, 'debit', '25.00');
    const transaction = processedTransaction(wallet, sample, 'BET', {
      playerId: randomUUID(),
      status: 'REJECTED',
      processedAt: undefined,
      failureCode: 'WALLET_PLAYER_MISMATCH',
      result: { status: 'REJECTED', balance: money('100.00').toJSON() },
    });
    await unit.run(async (tx) => {
      await tx.lockWallet(wallet.id);
      await tx.recordTransaction(transaction, eventsFor(transaction));
    });
    await assertBalance(wallet.id, '100.00', 1);
    expect(await countRows('wallet_ledger_entries', wallet.id)).toBe(1);
    expect(await countRows('wager_transactions', wallet.id)).toBe(2);
  });

  test('WAL-016: LOSS records its processed event without changing balance, version or ledger', async () => {
    const wallet = await seedWallet(unit);
    const sample = move(wallet, 'debit', '25.00');
    const transaction = processedTransaction(wallet, sample, 'LOSS', {
      money: money('0.00'),
      result: { status: 'PROCESSED', balance: money('100.00').toJSON() },
    });
    await unit.run(async (tx) => {
      await tx.lockWallet(wallet.id);
      await tx.recordTransaction(transaction, eventsFor(transaction));
    });
    await assertBalance(wallet.id, '100.00', 1);
    expect(await countRows('wallet_ledger_entries', wallet.id)).toBe(1);
    expect(await countRows('outbox_messages', wallet.id)).toBe(3);
  });

  test('outbox money must describe the actual ledger movement', async () => {
    const wallet = await seedWallet(unit);
    await expectDatabaseError(
      () =>
        unit.run(async (tx) => {
          const current = await tx.lockWallet(wallet.id);
          const entry = move(current, 'debit', '25.00');
          const transaction = processedTransaction(current, entry, 'BET');
          const events = eventsFor(transaction, entry);
          const event = events.find((e) => e.eventType === 'WalletBalanceChanged')!;
          (event.payload.data as Record<string, unknown>).money = money('24.99').toJSON();
          await tx.appendMovement(entry, transaction, events);
        }),
      '23514',
    );
    await assertBalance(wallet.id, '100.00', 1);
  });

  test.each(['idempotencyKey', 'externalTransactionId'] as const)(
    'unique financial identity protects %s across writes',
    async (field) => {
      const wallet = await seedWallet(unit);
      let original: ReturnType<typeof processedTransaction>;
      await unit.run(async (tx) => {
        const current = await tx.lockWallet(wallet.id);
        const entry = move(current, 'debit', '25.00');
        original = processedTransaction(current, entry, 'BET');
        await tx.appendMovement(entry, original, eventsFor(original, entry));
      });
      await expectDatabaseError(
        () =>
          unit.run(async (tx) => {
            const current = await tx.lockWallet(wallet.id);
            const entry = move(current, 'credit', '25.00');
            const transaction = processedTransaction(current, entry, 'WIN', {
              [field]: original[field],
            });
            await tx.appendMovement(entry, transaction, eventsFor(transaction, entry));
          }),
        'IDENTITY_COLLISION',
      );
      await assertBalance(wallet.id, '75.00', 2);
    },
  );

  test('REV-D01: REFUND and ROLLBACK cannot both reverse the same BET', async () => {
    const wallet = await seedWallet(unit);
    let bet: ReturnType<typeof processedTransaction>;
    await unit.run(async (tx) => {
      const current = await tx.lockWallet(wallet.id);
      const entry = move(current, 'debit', '25.00');
      bet = processedTransaction(current, entry, 'BET');
      await tx.appendMovement(entry, bet, eventsFor(bet, entry));
    });
    const reverse = (kind: 'REFUND' | 'ROLLBACK') =>
      unit.run(async (tx) => {
        const current = await tx.lockWallet(wallet.id);
        const entry = move(current, 'credit', '25.00');
        const transaction = processedTransaction(current, entry, kind, {
          referenceTransactionId: bet.id,
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        await tx.appendMovement(entry, transaction, eventsFor(transaction, entry));
      });
    await reverse('REFUND');
    await expectDatabaseError(() => reverse('ROLLBACK'), '23505');
    await assertBalance(wallet.id, '100.00', 3);
    expect(await countRows('wallet_ledger_entries', wallet.id)).toBe(3);
  });

  test('wallet identity remains immutable even through the migration owner', async () => {
    const wallet = await seedWallet(unit);
    await expectDatabaseError(
      () =>
        owner.em
          .fork()
          .execute('update financial.wallets set player_id = ? where id = ?', [
            randomUUID(),
            wallet.id,
          ]),
      '23514',
    );
    await expectDatabaseError(() => sql('set role wager_migrator'), '42501');
    await expectDatabaseError(() => sql("set session_replication_role = 'replica'"), '42501');
    await assertBalance(wallet.id, '100.00', 1);
  });

  test('WAL-024 / WAL-025: three real processes serialize one wallet while another advances', async () => {
    const contested = await seedWallet(unit);
    const independent = await seedWallet(unit);
    const namedUrl = (name: string): string => {
      const url = new URL(appDatabaseUrl);
      url.searchParams.set('application_name', name);
      return url.href;
    };
    const held = launchRaceWorker(namedUrl('wager-proof-held'), contested.id, '80.00', 'hold');
    const waiter = launchRaceWorker(namedUrl('wager-proof-waiter'), contested.id, '80.00');
    const other = launchRaceWorker(namedUrl('wager-proof-other'), independent.id, '10.00');
    const workers = [held, waiter, other];
    try {
      const ready = await Promise.all(workers.map((worker) => worker.waitFor('READY')));
      expect(new Set(ready.map((message) => message.pid)).size).toBe(3);
      held.child.send({ type: 'START' });
      await held.waitFor('LOCKED');
      waiter.child.send({ type: 'START' });
      const deadline = Date.now() + 4000;
      let blocked = false;
      while (Date.now() < deadline) {
        const [row] = await admin.em.fork().execute<Record<string, unknown>[]>(
          `select exists(select 1 from pg_stat_activity where datname = ? and application_name = 'wager-proof-waiter'
            and wait_event_type = 'Lock') as blocked`,
          [databaseName],
        );
        if (row?.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      other.child.send({ type: 'START' });
      expect((await other.waitFor('DONE')).status).toBe('PROCESSED');
      await assertBalance(independent.id, '90.00', 2);
      await assertBalance(contested.id, '100.00', 1);
      held.child.send({ type: 'RELEASE' });
      const results = await Promise.all([held.waitFor('DONE'), waiter.waitFor('DONE')]);
      expect(results.map((result) => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
      expect(await Promise.all(workers.map((worker) => worker.child.exited))).toEqual([0, 0, 0]);
      await assertBalance(contested.id, '20.00', 2);
      expect(await countRows('wallet_ledger_entries', contested.id)).toBe(2);
      const rows = await sql(
        "select status, failure_code from financial.wager_transactions where wallet_id = ? and kind = 'BET' order by status",
        [contested.id],
      );
      expect(rows).toEqual([
        { status: 'PROCESSED', failure_code: null },
        { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
      ]);
    } finally {
      for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
      await Promise.all(workers.map((worker) => worker.child.exited));
    }
  });
});
