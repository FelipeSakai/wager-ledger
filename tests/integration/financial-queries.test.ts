import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type {
  FinancialReadSnapshot,
  FinancialReadStore,
} from '../../src/modules/financial/application/ports/financial-read-store';
import { FinancialQueries } from '../../src/modules/financial/application/queries/financial-queries';
import { OpenWallet } from '../../src/modules/financial/application/use-cases/open-wallet';
import { ProcessTransaction } from '../../src/modules/financial/application/use-cases/process-transaction';
import { FinancialQueryDiagnostics } from '../../src/modules/financial/infrastructure/observability/query-diagnostics';
import { MikroFinancialUnitOfWork } from '../../src/modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { HmacLedgerCursor } from '../../src/modules/financial/infrastructure/queries/hmac-ledger-cursor';
import { MikroFinancialReadStore } from '../../src/modules/financial/infrastructure/queries/mikro-financial-read-store';
import { systemFinancialRuntime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';
import { financialTestDatabase } from '../support/financial-test-database';

let db: Awaited<ReturnType<typeof financialTestDatabase>>;
let store: MikroFinancialReadStore;
let queries: FinancialQueries;
let openCase: OpenWallet;
let processor: ProcessTransaction;
const logs: unknown[] = [];
const diagnostics = new FinancialQueryDiagnostics((value) => logs.push(value));
const codec = new HmacLedgerCursor('read-test-fixture-key-at-least-32-bytes');
const fixedRuntime = { ...systemFinancialRuntime, now: () => new Date('2026-10-27T20:00:00Z') };
const open = (amount = '100.00') =>
  openCase.execute({ playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
function move(wallet: { id: string; playerId: string }, amount: string, kind = 'WIN') {
  return processor.execute(
    {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: { amount, currency: 'BRL' },
    },
    randomUUID(),
  );
}
beforeAll(async () => {
  db = await financialTestDatabase();
  const unit = new MikroFinancialUnitOfWork(db.app);
  store = new MikroFinancialReadStore(db.app);
  queries = new FinancialQueries(store, codec, diagnostics);
  openCase = new OpenWallet(unit, fixedRuntime);
  processor = new ProcessTransaction(unit, fixedRuntime, ['provider-a']);
}, 30000);
afterAll(async () => {
  if (db) await db.close();
}, 30000);

describe('Query snapshots and diagnostics — real PostgreSQL', () => {
  test('QRY-005: repeated timestamps still order only by financial version', async () => {
    const wallet = await open();
    await move(wallet, '1.00');
    await move(wallet, '2.00');
    const page = await queries.ledger(wallet.id, { limit: '3' });
    expect(page.items.map((entry) => entry.walletVersion)).toEqual([3, 2, 1]);
    expect(new Set(page.items.map((entry) => entry.createdAt)).size).toBe(1);
    expect(await queries.reconcile(wallet.id, randomUUID())).toMatchObject({
      consistent: true,
      checkedEntries: 3,
      storedBalance: { amount: '103.00' },
    });
  });
  test('QRY-010: a real concurrent commit between wallet and sum cannot change the snapshot', async () => {
    const wallet = await open();
    let release!: () => void;
    let captured!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const coordinated: FinancialReadStore = {
      snapshot: (read) =>
        store.snapshot((snapshot) =>
          read({
            ...snapshot,
            wallet: async (id) => {
              const value = await snapshot.wallet(id);
              captured();
              await barrier;
              return value;
            },
            ledger: snapshot.ledger.bind(snapshot),
            transaction: snapshot.transaction.bind(snapshot),
            externalTransaction: snapshot.externalTransaction.bind(snapshot),
            reconciliation: snapshot.reconciliation.bind(snapshot),
          }),
        ),
    };
    const report = new FinancialQueries(coordinated, codec, diagnostics).reconcile(
      wallet.id,
      randomUUID(),
    );
    await ready;
    try {
      const committed = await move(wallet, '25.00');
      expect(committed.balance.amount).toBe('125.00');
    } finally {
      release();
    }
    expect(await report).toMatchObject({
      storedBalance: { amount: '100.00' },
      calculatedBalance: { amount: '100.00' },
      consistent: true,
      checkedEntries: 1,
    });
    expect(await queries.reconcile(wallet.id, randomUUID())).toMatchObject({
      storedBalance: { amount: '125.00' },
      calculatedBalance: { amount: '125.00' },
      consistent: true,
      checkedEntries: 2,
    });
  });
  test('QRY-012: many large movements cancel exactly without using bounded Money for the sum', async () => {
    const maximum = '999999999999999999.99';
    const wallet = await open(maximum);
    for (let i = 0; i < 3; i++) {
      await move(wallet, maximum, 'BET');
      await move(wallet, maximum);
    }
    expect(await queries.reconcile(wallet.id, randomUUID())).toMatchObject({
      consistent: true,
      checkedEntries: 7,
      storedBalance: { amount: maximum },
      calculatedBalance: { amount: maximum },
      difference: { amount: '0.00' },
    });
  });
  test('read transactions are REPEATABLE READ / READ ONLY and contexts cannot escape', async () => {
    const recorded: { snapshot?: FinancialReadSnapshot } = {};
    await store.snapshot(async (snapshot) => {
      recorded.snapshot = snapshot;
    });
    await expect(recorded.snapshot!.wallet(randomUUID())).rejects.toThrow(
      'Read snapshot is no longer active',
    );
    // The SQL options are observed through the same transactional connection, never by a separate pool read.
    const originalFork = db.app.em.fork.bind(db.app.em);
    const settings: unknown[] = [];
    const em = db.app.em;
    const fork = em.fork;
    em.fork = ((...args: Parameters<typeof fork>) => {
      const context = originalFork(...args);
      const transactional = context.transactional.bind(context);
      context.transactional = ((
        callback: (inner: typeof context) => Promise<unknown>,
        options: unknown,
      ) =>
        transactional(async (inner) => {
          const execute = inner.execute.bind(inner);
          inner.execute = (async (...values: Parameters<typeof execute>) => {
            const result = await execute(...values);
            if (values[0] === 'set transaction read only')
              settings.push(
                await execute(
                  "select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as readonly",
                ),
              );
            return result;
          }) as typeof inner.execute;
          return callback(inner);
        }, options as never)) as typeof context.transactional;
      return context;
    }) as typeof em.fork;
    try {
      await queries.wallet((await open()).id);
    } finally {
      em.fork = fork;
    }
    expect(settings).toContainEqual([{ isolation: 'repeatable read', readonly: 'on' }]);
  });
  test('QRY-011: finite divergence emits diagnostics and counters without repairing financial state', async () => {
    const wallet = await open();
    await db.owner.em.fork().transactional(async (em) => {
      await em.execute('alter table financial.wallets disable trigger user');
      await em.execute('update financial.wallets set balance=? where id=?', ['99.00', wallet.id]);
      await em.execute('alter table financial.wallets enable trigger user');
    });
    const before = await db.observer.em
      .fork()
      .execute(
        'select balance::text, version::text, updated_at from financial.wallets where id=?',
        [wallet.id],
      );
    const counters = diagnostics.counters();
    const correlationId = randomUUID();
    expect(await queries.reconcile(wallet.id, correlationId)).toMatchObject({
      consistent: false,
      storedBalance: { amount: '99.00' },
      calculatedBalance: { amount: '100.00' },
      difference: { amount: '-1.00' },
      issues: ['BALANCE_MISMATCH'],
    });
    expect(
      await db.observer.em
        .fork()
        .execute(
          'select balance::text, version::text, updated_at from financial.wallets where id=?',
          [wallet.id],
        ),
    ).toEqual(before);
    expect(diagnostics.counters().reconciliationDivergences).toBe(
      counters.reconciliationDivergences + 1,
    );
    expect(logs.at(-1)).toEqual({
      level: 'error',
      event: 'financial_reconciliation_divergence',
      walletId: wallet.id,
      issues: ['BALANCE_MISMATCH'],
      correlationId,
    });
    expect(JSON.stringify(logs.at(-1))).not.toMatch(/99.00|100.00|password|postgresql/);
  });
  test('QRY-013: finite diagnostic totals can exceed Money range without truncation', async () => {
    const isolated = await financialTestDatabase();
    try {
      const unit = new MikroFinancialUnitOfWork(isolated.app);
      const opening = new OpenWallet(unit, fixedRuntime);
      const wallet = await opening.execute({
        playerId: randomUUID(),
        initialBalance: { amount: '999999999999999999.99', currency: 'BRL' },
      });
      const process = new ProcessTransaction(unit, fixedRuntime, ['provider-a']);
      const debit = await process.execute(
        {
          providerId: 'provider-a',
          externalTransactionId: randomUUID(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '999999999999999999.99', currency: 'BRL' },
        },
        randomUUID(),
      );
      // Administrative corruption is restricted to this disposable fixture database.
      await isolated.owner.em.fork().transactional(async (em) => {
        await em.execute('alter table financial.wallet_ledger_entries disable trigger user');
        await em.execute(
          'alter table financial.wallet_ledger_entries drop constraint wallet_ledger_entries_check',
        );
        await em.execute(
          "update financial.wallet_ledger_entries set direction='CREDIT' where transaction_id=?",
          [debit.transactionId],
        );
        await em.execute('alter table financial.wallet_ledger_entries enable trigger user');
      });
      const report = await new FinancialQueries(
        new MikroFinancialReadStore(isolated.app),
        codec,
        diagnostics,
      ).reconcile(wallet.id, randomUUID());
      expect(report).toMatchObject({
        consistent: false,
        calculatedBalance: { amount: '1999999999999999999.98' },
        difference: { amount: '-1999999999999999999.98' },
        checkedEntries: 2,
      });
      expect(report.issues).toContain('CALCULATED_BALANCE_OUT_OF_RANGE');
      expect(report.issues).toContain('DIFFERENCE_OUT_OF_RANGE');
      expect(
        (
          await new FinancialQueries(
            new MikroFinancialReadStore(isolated.app),
            codec,
            diagnostics,
          ).wallet(wallet.id)
        ).balance.amount,
      ).toBe('0.00');
    } finally {
      await isolated.close();
    }
  });
  test('QRY-013: non-finite ledger corruption becomes an integrity error', async () => {
    const isolated = await financialTestDatabase();
    try {
      const unit = new MikroFinancialUnitOfWork(isolated.app);
      const wallet = await new OpenWallet(unit, fixedRuntime).execute({
        playerId: randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      await isolated.owner.em.fork().transactional(async (em) => {
        await em.execute('alter table financial.wallet_ledger_entries disable trigger user');
        await em.execute(
          'alter table financial.wallet_ledger_entries drop constraint wallet_ledger_entries_check',
        );
        await em.execute(
          'alter table financial.wallet_ledger_entries drop constraint wallet_ledger_entries_amount_check',
        );
        await em.execute(
          "update financial.wallet_ledger_entries set amount='NaN'::numeric where wallet_id=?",
          [wallet.id],
        );
        await em.execute('alter table financial.wallet_ledger_entries enable trigger user');
      });
      await expect(
        new FinancialQueries(
          new MikroFinancialReadStore(isolated.app),
          codec,
          diagnostics,
        ).reconcile(wallet.id, randomUUID()),
      ).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' });
    } finally {
      await isolated.close();
    }
  });
});
