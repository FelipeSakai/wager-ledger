import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { FinancialPersistence } from '../../src/modules/financial/application/ports/financial-persistence';
import type { FinancialUnitOfWork } from '../../src/modules/financial/application/ports/financial-unit-of-work';
import { OpenWallet } from '../../src/modules/financial/application/use-cases/open-wallet';
import { ProcessTransaction } from '../../src/modules/financial/application/use-cases/process-transaction';
import { ResumePendingTransaction } from '../../src/modules/financial/application/use-cases/resume-pending-transaction';
import { MikroFinancialUnitOfWork } from '../../src/modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { systemFinancialRuntime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';
import { financialTestDatabase } from '../support/financial-test-database';
import { useCaseRace } from '../support/use-case-race';

let db: Awaited<ReturnType<typeof financialTestDatabase>>;
let unit: FinancialUnitOfWork;
let time = Date.parse('2026-10-27T18:00:00.000Z');
const runtime = { ...systemFinancialRuntime, now: () => new Date(time), random: () => 0 };
const processWith = (u = unit, providers = ['provider-a', 'provider-b']) =>
  new ProcessTransaction(u, runtime, providers);
const open = (amount = '100.00', playerId: string = randomUUID(), u = unit) =>
  new OpenWallet(u, runtime).execute({ playerId, initialBalance: { amount, currency: 'BRL' } });
function command(
  wallet: { id: string; playerId: string },
  kind = 'BET',
  amount = '25.00',
  extra: Record<string, unknown> = {},
) {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}
async function sql(query: string, params: unknown[] = []) {
  return db.observer.em.fork().execute<Record<string, unknown>[]>(query, params);
}
async function balance(id: string, amount: string, version?: number) {
  const [row] = await sql(
    `select w.balance::text as balance, w.version::text as version,
    w.balance = coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0) as reconciled
    from financial.wallets w left join financial.wallet_ledger_entries l on l.wallet_id=w.id where w.id=? group by w.id`,
    [id],
  );
  expect(row?.balance).toBe(amount);
  expect(row?.reconciled).toBe(true);
  if (version !== undefined) expect(row?.version).toBe(String(version));
}
async function counts(id: string) {
  const [row] = await sql(
    `select (select count(*)::integer from financial.wager_transactions where wallet_id=?) as transactions,
    (select count(*)::integer from financial.wallet_ledger_entries where wallet_id=?) as ledger,
    (select count(*)::integer from financial.outbox_messages where aggregate_id=?) as events`,
    [id, id, id],
  );
  return row;
}
function intercept(
  method: keyof FinancialPersistence,
  after: () => Promise<void>,
): FinancialUnitOfWork {
  return {
    run: (work) =>
      unit.run((persistence) =>
        work(
          new Proxy(persistence, {
            get(target, property) {
              const value = Reflect.get(target, property);
              if (typeof value !== 'function') return value;
              return async (...args: unknown[]) => {
                const result: unknown = await value.apply(target, args);
                if (property === method) await after();
                return result;
              };
            },
          }),
        ),
      ),
  };
}
beforeAll(async () => {
  db = await financialTestDatabase();
  unit = new MikroFinancialUnitOfWork(db.app);
}, 30000);
afterAll(async () => {
  if (db) await db.close();
}, 30000);

describe('Financial application — real PostgreSQL', () => {
  test('WAL-001/002/033/034: open zero and positive wallets through the use case', async () => {
    for (const amount of ['0.00', '100.00', '999999999999999999.99']) {
      const wallet = await open(amount);
      await balance(wallet.id, amount, 1);
      expect(await counts(wallet.id)).toEqual(
        amount === '0.00'
          ? { transactions: 0, ledger: 0, events: 0 }
          : { transactions: 1, ledger: 1, events: 2 },
      );
      const [tx] = await sql(
        'select origin, internal_identity, provider_id from financial.wager_transactions where wallet_id=?',
        [wallet.id],
      );
      if (amount !== '0.00')
        expect(tx).toEqual({
          origin: 'INTERNAL',
          internal_identity: `opening:${wallet.id}`,
          provider_id: null,
        });
    }
  });
  test('WAL-030/041: duplicate opening recovers walletId and preserves original balance', async () => {
    const wallet = await open();
    await expect(open('250.00', wallet.playerId)).rejects.toMatchObject({
      code: 'WALLET_ALREADY_EXISTS',
      details: { walletId: wallet.id },
    });
    await balance(wallet.id, '100.00', 1);
  });
  test('concurrent openings resolve the unique collision after rollback', async () => {
    const playerId = randomUUID();
    const results = await Promise.allSettled([open('100.00', playerId), open('100.00', playerId)]);
    const winner = results.find((r) => r.status === 'fulfilled');
    expect(winner?.status).toBe('fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('Expected opening winner');
    const loser = results.find((r) => r.status === 'rejected');
    expect(loser?.status === 'rejected' && loser.reason).toMatchObject({
      code: 'WALLET_ALREADY_EXISTS',
      details: { walletId: winner.value.id },
    });
    await balance(winner.value.id, '100.00', 1);
  });
  test('PROC-001/002/003/005: BET, WIN, LOSS and historical replay', async () => {
    const wallet = await open();
    const bet = command(wallet);
    const key = randomUUID();
    const processor = processWith();
    const first = await processor.execute(bet, key);
    expect(first).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    await processor.execute(command(wallet, 'WIN', '10.00'), randomUUID());
    const [before] = await sql('select updated_at from financial.wallets where id=?', [wallet.id]);
    const loss = await processor.execute(command(wallet, 'LOSS', '0.00'), randomUUID());
    expect(loss.balance.amount).toBe('85.00');
    expect(await sql('select updated_at from financial.wallets where id=?', [wallet.id])).toEqual([
      before!,
    ]);
    const replay = await processor.execute(bet, key, randomUUID());
    expect(replay).toEqual({
      ...first,
      idempotentReplay: true,
      correlationId: replay.correlationId,
    });
    expect(await counts(wallet.id)).toEqual({ transactions: 4, ledger: 3, events: 7 });
    await balance(wallet.id, '85.00', 3);
  });
  test.each([
    ['BET', '0.00'],
    ['WIN', '0.00'],
    ['LOSS', '0.01'],
  ])('PROC-004: %s %s is an auditable rejection', async (kind, amount) => {
    const wallet = await open();
    const result = await processWith().execute(command(wallet, kind, amount), randomUUID());
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_OPERATION_AMOUNT' });
    await balance(wallet.id, '100.00', 1);
    expect(await counts(wallet.id)).toEqual({ transactions: 2, ledger: 1, events: 3 });
  });
  test('legacy persisted replies retain their historical snapshot without changing immutable records', async () => {
    const wallet = await open();
    const legacyUnit: FinancialUnitOfWork = {
      run: (work, timeouts) =>
        unit.run(
          (persistence) =>
            work(
              new Proxy(persistence, {
                get(target, property) {
                  const legacy = (
                    transaction: Parameters<FinancialPersistence['recordTransaction']>[0],
                  ) => {
                    if (!transaction.result) return transaction;
                    const statuses: Record<string, number> = {
                      PROCESSED: 200,
                      REJECTED: 422,
                      PENDING_REFERENCE: 202,
                      FAILED: 500,
                    };
                    return {
                      ...transaction,
                      result: { ...transaction.result, httpStatus: statuses[transaction.status] },
                    };
                  };
                  if (property === 'appendMovement')
                    return (...args: Parameters<FinancialPersistence['appendMovement']>) =>
                      target.appendMovement(args[0], legacy(args[1]), args[2]);
                  if (property === 'recordTransaction')
                    return (...args: Parameters<FinancialPersistence['recordTransaction']>) =>
                      target.recordTransaction(legacy(args[0]), args[1]);
                  const value = Reflect.get(target, property);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              }),
            ),
          timeouts,
        ),
    };
    const inputs = [
      command(wallet),
      command(wallet, 'BET', '150.00'),
      command(wallet, 'REFUND', '25.00', { referenceExternalTransactionId: 'not-yet-available' }),
    ];
    const keys = inputs.map(() => randomUUID());
    const original = [];
    for (let index = 0; index < inputs.length; index++)
      original.push(await processWith(legacyUnit).execute(inputs[index], keys[index]));
    const before = await sql(
      'select id, result::text as result from financial.wager_transactions where wallet_id=? order by id',
      [wallet.id],
    );
    await processWith().execute(command(wallet, 'WIN', '10.00'), randomUUID());
    for (let index = 0; index < inputs.length; index++) {
      const replay = await processWith().execute(inputs[index], keys[index]);
      expect(replay).toEqual({
        ...original[index]!,
        idempotentReplay: true,
        correlationId: replay.correlationId,
      });
      expect(replay).not.toHaveProperty('httpStatus');
      const persisted = await unit.run((persistence) =>
        persistence.findWager(replay.transactionId),
      );
      expect(persisted?.result).not.toHaveProperty('httpStatus');
      expect(
        await sql(
          'select id, result::text as result from financial.wager_transactions where id=?',
          [replay.transactionId],
        ),
      ).toEqual(before.filter((row) => row.id === replay.transactionId));
    }
    const [current] = await sql(
      `select result from financial.wager_transactions where wallet_id=? and kind='WIN'`,
      [wallet.id],
    );
    expect(current?.result).not.toHaveProperty('httpStatus');
    await balance(wallet.id, '85.00', 3);
  });
  test('insufficient funds rejection is stable after a subsequent credit', async () => {
    const wallet = await open();
    const bet = command(wallet, 'BET', '150.00');
    const key = randomUUID();
    const first = await processWith().execute(bet, key);
    expect(first.failureCode).toBe('INSUFFICIENT_FUNDS');
    await processWith().execute(command(wallet, 'WIN', '100.00'), randomUUID());
    expect(await processWith().execute(bet, key)).toMatchObject({
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '100.00' },
      idempotentReplay: true,
    });
    await balance(wallet.id, '200.00', 2);
  });
  test('PROC-006/007/008/019: identity conflicts precede missing wallet and preserve the original', async () => {
    const wallet = await open();
    const bet = command(wallet);
    const key = randomUUID();
    await processWith().execute(bet, key);
    for (const changed of [
      { money: { amount: '26.00', currency: 'BRL' } },
      { walletId: randomUUID() },
      { playerId: randomUUID() },
      { kind: 'WIN' },
      { providerId: 'provider-b' },
    ]) {
      await expect(processWith().execute({ ...bet, ...changed }, key)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
    }
    await expect(processWith().execute(bet, randomUUID())).rejects.toMatchObject({
      code: 'EXTERNAL_TRANSACTION_CONFLICT',
    });
    await balance(wallet.id, '75.00', 2);
    expect(await counts(wallet.id)).toEqual({ transactions: 2, ledger: 2, events: 4 });
  });
  test('durable replay remains valid when the provider is no longer admitted', async () => {
    const wallet = await open();
    const bet = command(wallet);
    const key = randomUUID();
    const first = await processWith().execute(bet, key);
    expect(await processWith(unit, []).execute(bet, key)).toMatchObject({
      transactionId: first.transactionId,
      idempotentReplay: true,
    });
    await expect(
      processWith(unit, []).execute(command(wallet), randomUUID()),
    ).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER' });
    await balance(wallet.id, '75.00', 2);
  });
  test('PROC-021/022/023: credit overflow is durable, input overflow is not admitted', async () => {
    const wallet = await open('999999999999999999.99');
    const win = command(wallet, 'WIN', '0.01');
    const key = randomUUID();
    expect(await processWith().execute(win, key)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'MONEY_OUT_OF_RANGE',
    });
    await processWith().execute(command(wallet, 'BET', '0.01'), randomUUID());
    expect(await processWith().execute(win, key)).toMatchObject({
      failureCode: 'MONEY_OUT_OF_RANGE',
      idempotentReplay: true,
      balance: { amount: '999999999999999999.99' },
    });
    await expect(
      processWith().execute(command(wallet, 'WIN', '1000000000000000000.00'), randomUUID()),
    ).rejects.toMatchObject({ code: 'MONEY_OUT_OF_RANGE' });
    await balance(wallet.id, '999999999999999999.98', 2);
  });
  test('player mismatch is audited and persisted with no movement', async () => {
    const wallet = await open();
    expect(
      await processWith().execute(
        command(wallet, 'BET', '25.00', { playerId: randomUUID() }),
        randomUUID(),
      ),
    ).toMatchObject({ failureCode: 'WALLET_PLAYER_MISMATCH' });
    await balance(wallet.id, '100.00', 1);
  });
  test('PROC-014: injected failure after a real flush rolls back opening and processing', async () => {
    const failure = new Error('Injected failure');
    const failing = intercept('appendMovement', async () => {
      throw failure;
    });
    const player = randomUUID();
    await expect(open('100.00', player, failing)).rejects.toBe(failure);
    expect(await sql('select id from financial.wallets where player_id=?', [player])).toHaveLength(
      0,
    );
    const wallet = await open();
    await expect(processWith(failing).execute(command(wallet), randomUUID())).rejects.toBe(failure);
    expect(await counts(wallet.id)).toEqual({ transactions: 1, ledger: 1, events: 2 });
    await balance(wallet.id, '100.00', 1);
  });
  test('cross-wallet global key collision returns a conflict after full rollback', async () => {
    const a = await open();
    const b = await open();
    const key = randomUUID();
    const results = await Promise.allSettled([
      processWith().execute(command(a), key),
      processWith().execute(command(b), key),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const rows = await sql(
      'select balance::text as balance from financial.wallets where id in (?,?) order by balance',
      [a.id, b.id],
    );
    expect(rows.map((r) => r.balance)).toEqual(['100.00', '75.00']);
    for (const wallet of [a, b]) {
      const [row] = await sql('select balance::text as amount from financial.wallets where id=?', [
        wallet.id,
      ]);
      await balance(wallet.id, row!.amount as string);
    }
  });
  test('REV-001/002/003/022: refund and rollback preserve history and consume one reversal per reference', async () => {
    const wallet = await open();
    const bet = command(wallet);
    await processWith().execute(bet, randomUUID());
    const refund = command(wallet, 'REFUND', '25.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const key = randomUUID();
    expect(await processWith().execute(refund, key)).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00' },
    });
    await processWith().execute(
      command(wallet, 'ROLLBACK', '25.00', {
        referenceExternalTransactionId: refund.externalTransactionId,
      }),
      randomUUID(),
    );
    const denied = await processWith().execute(
      command(wallet, 'ROLLBACK', '25.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      randomUUID(),
    );
    expect(denied.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await processWith().execute(refund, key)).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: true,
      balance: { amount: '100.00' },
    });
    await balance(wallet.id, '75.00', 4);
  });
  test('REV-002/009: reversing a WIN debits and has its own insufficient funds code', async () => {
    const wallet = await open('0.00');
    const win = command(wallet, 'WIN', '50.00');
    await processWith().execute(win, randomUUID());
    await processWith().execute(command(wallet, 'BET', '40.00'), randomUUID());
    expect(
      await processWith().execute(
        command(wallet, 'ROLLBACK', '50.00', {
          referenceExternalTransactionId: win.externalTransactionId,
        }),
        randomUUID(),
      ),
    ).toMatchObject({ failureCode: 'REVERSAL_INSUFFICIENT_FUNDS' });
    await balance(wallet.id, '10.00', 3);
  });
  test('REV-007: missing reference is durable; replay does not retry; resume applies once', async () => {
    const wallet = await open();
    const bet = command(wallet);
    const refund = command(wallet, 'REFUND', '25.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const key = randomUUID();
    const pending = await processWith().execute(refund, key);
    expect(pending.status).toBe('PENDING_REFERENCE');
    expect(await processWith().execute(refund, key)).toMatchObject({
      transactionId: pending.transactionId,
      idempotentReplay: true,
    });
    let [row] = await sql(
      'select reference_attempts, next_reference_attempt_at, reference_expires_at from financial.wager_transactions where id=?',
      [pending.transactionId],
    );
    expect(row?.reference_attempts).toBe(1);
    expect(typeof row?.next_reference_attempt_at).toBe('string');
    expect(
      await new ResumePendingTransaction(unit, runtime).execute(pending.transactionId),
    ).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: true });
    await processWith().execute(bet, randomUUID());
    time += 3000;
    expect(
      await new ResumePendingTransaction(unit, runtime).execute(pending.transactionId),
    ).toMatchObject({ status: 'PROCESSED' });
    expect(
      await new ResumePendingTransaction(unit, runtime).execute(pending.transactionId),
    ).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
    expect(await processWith().execute(refund, key)).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: true,
    });
    expect(await counts(wallet.id)).toEqual({ transactions: 3, ledger: 3, events: 7 });
    await balance(wallet.id, '100.00', 3);
  });
  test('REV-010: unavailable reference expires, emits one rejection and never reopens', async () => {
    const wallet = await open();
    const input = command(wallet, 'REFUND', '25.00', {
      referenceExternalTransactionId: randomUUID(),
    });
    const key = randomUUID();
    const pending = await processWith().execute(input, key);
    time += 24 * 60 * 60 * 1000;
    expect(
      await new ResumePendingTransaction(unit, runtime).execute(pending.transactionId),
    ).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND_EXPIRED' });
    expect(
      await new ResumePendingTransaction(unit, runtime).execute(pending.transactionId),
    ).toMatchObject({ idempotentReplay: true });
    await balance(wallet.id, '100.00', 1);
    expect(await counts(wallet.id)).toEqual({ transactions: 2, ledger: 1, events: 4 });
  });
  test('pending recheck preserves deadline and does not duplicate the pending event', async () => {
    const wallet = await open();
    const pending = await processWith().execute(
      command(wallet, 'WIN', '10.00', { referenceExternalTransactionId: randomUUID() }),
      randomUUID(),
    );
    const [before] = await sql(
      'select reference_expires_at from financial.wager_transactions where id=?',
      [pending.transactionId],
    );
    time += 3000;
    await new ResumePendingTransaction(unit, runtime).execute(pending.transactionId);
    const [after] = await sql(
      'select reference_attempts, reference_expires_at from financial.wager_transactions where id=?',
      [pending.transactionId],
    );
    expect(after?.reference_attempts).toBe(2);
    expect(after?.reference_expires_at).toEqual(before?.reference_expires_at);
    expect(await counts(wallet.id)).toEqual({ transactions: 2, ledger: 1, events: 3 });
    await balance(wallet.id, '100.00', 1);
  });
  test('real lock timeout retries with a fresh context and eventually returns unavailable without FAILED', async () => {
    const wallet = await open();
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = unit.run(async (p) => {
      await p.lockWallet(wallet.id);
      locked();
      await done;
    });
    await ready;
    try {
      await expect(processWith().execute(command(wallet), randomUUID())).rejects.toMatchObject({
        code: 'INFRASTRUCTURE_UNAVAILABLE',
      });
    } finally {
      release();
      await blocker;
    }
    await balance(wallet.id, '100.00', 1);
    expect(await counts(wallet.id)).toEqual({ transactions: 1, ledger: 1, events: 2 });
  });
  test('reference limits and backoff are configurable without changing business code', async () => {
    const policy = {
      referenceWaitMilliseconds: 1000,
      referenceMaxAttempts: 2,
      referenceBaseDelayMilliseconds: 10,
      referenceMaxDelayMilliseconds: 10,
    };
    const wallet = await open();
    const processor = new ProcessTransaction(unit, runtime, ['provider-a'], policy);
    const pending = await processor.execute(
      command(wallet, 'WIN', '10.00', { referenceExternalTransactionId: randomUUID() }),
      randomUUID(),
    );
    const resume = new ResumePendingTransaction(unit, runtime, policy);
    time += 6;
    expect(await resume.execute(pending.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
    });
    time += 6;
    expect(await resume.execute(pending.transactionId)).toMatchObject({
      failureCode: 'REFERENCE_NOT_FOUND_EXPIRED',
    });
    await balance(wallet.id, '100.00', 1);
  });
  test('migration upgrade preserves an existing terminal result, hash and ledger', async () => {
    const isolated = await financialTestDatabase();
    try {
      const isolatedUnit = new MikroFinancialUnitOfWork(isolated.app);
      const wallet = await open('100.00', randomUUID(), isolatedUnit);
      const input = command(wallet);
      const key = randomUUID();
      const first = await processWith(isolatedUnit).execute(input, key);
      await isolated.owner.migrator.down();
      await isolated.owner.migrator.up();
      expect(await processWith(isolatedUnit).execute(input, key)).toMatchObject({
        transactionId: first.transactionId,
        balance: first.balance,
        idempotentReplay: true,
      });
      const [row] = await isolated.observer.em
        .fork()
        .execute<Record<string, unknown>[]>(
          "select w.balance::text as amount, w.balance=coalesce(sum(case when l.direction='CREDIT' then l.amount else -l.amount end),0) as reconciled from financial.wallets w left join financial.wallet_ledger_entries l on l.wallet_id=w.id where w.id=? group by w.id",
          [wallet.id],
        );
      expect(row).toMatchObject({ amount: '75.00', reconciled: true });
    } finally {
      await isolated.close();
    }
  });
  test('identity reservation colliding on an external ID with a different key is recovered safely', async () => {
    const wallet = await open();
    const input = command(wallet);
    const results = await Promise.allSettled([
      processWith().execute(input, randomUUID()),
      processWith().execute(input, randomUUID()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected');
    expect(loser?.status === 'rejected' && loser.reason).toMatchObject({
      code: 'EXTERNAL_TRANSACTION_CONFLICT',
    });
    await balance(wallet.id, '75.00', 2);
  });
  test('REV-018/019: referenced WIN may differ in amount and LOSS remains zero in persistence', async () => {
    const wallet = await open();
    const bet = command(wallet);
    await processWith().execute(bet, randomUUID());
    const reference = {
      referenceExternalTransactionId: bet.externalTransactionId,
      gameId: 'another-game',
    };
    expect(
      await processWith().execute(command(wallet, 'WIN', '10.00', reference), randomUUID()),
    ).toMatchObject({ status: 'PROCESSED' });
    expect(
      await processWith().execute(command(wallet, 'LOSS', '0.00', reference), randomUUID()),
    ).toMatchObject({ status: 'PROCESSED' });
    await balance(wallet.id, '85.00', 3);
  });
  test('contract validation and missing wallet do not reserve a financial identity', async () => {
    const wallet = await open();
    const original = await counts(wallet.id);
    for (const extra of [
      { origin: 'INTERNAL' },
      { referenceExternalTransactionId: null },
      { money: { amount: 25, currency: 'BRL' } },
    ]) {
      await expect(
        processWith().execute({ ...command(wallet), ...extra }, randomUUID()),
      ).rejects.toBeInstanceOf(Error);
    }
    await expect(
      processWith().execute(
        command(wallet, 'BET', '25.00', { walletId: randomUUID() }),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    await expect(
      new OpenWallet(unit, runtime).execute({
        playerId: randomUUID(),
        initialBalance: { amount: '25.00', currency: 'USD' },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_WALLET_CURRENCY' });
    expect(await counts(wallet.id)).toEqual(original);
    await balance(wallet.id, '100.00', 1);
  });
  test('two concurrent resumptions re-read the same pending operation under the wallet lock', async () => {
    const wallet = await open();
    const bet = command(wallet);
    const pending = await processWith().execute(
      command(wallet, 'REFUND', '25.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      randomUUID(),
    );
    await processWith().execute(bet, randomUUID());
    time += 3000;
    const results = await Promise.all([
      new ResumePendingTransaction(unit, runtime).execute(pending.transactionId),
      new ResumePendingTransaction(unit, runtime).execute(pending.transactionId),
    ]);
    expect(results.filter((result) => result?.idempotentReplay === false)).toHaveLength(1);
    expect(results.every((result) => result?.status === 'PROCESSED')).toBe(true);
    expect(await counts(wallet.id)).toEqual({ transactions: 3, ledger: 3, events: 7 });
    await balance(wallet.id, '100.00', 3);
  });
  test('PROC-011: 50 duplicates across three ready processes produce one debit and stable replays', async () => {
    const wallet = await open();
    const input = command(wallet);
    const key = randomUUID();
    const workers = [0, 1, 2].map((i) => {
      const url = new URL(db.url);
      url.searchParams.set('application_name', `duplicates-${i}`);
      return useCaseRace(url.href);
    });
    try {
      const ready = await Promise.all(workers.map((worker) => worker.wait('READY')));
      expect(new Set(ready.map((message) => message.pid)).size).toBe(3);
      let release!: () => void;
      let locked!: () => void;
      const readyLock = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holdLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = unit.run(async (p) => {
        await p.lockWallet(wallet.id);
        locked();
        await holdLock;
      });
      await readyLock;
      try {
        workers.forEach((worker, index) =>
          worker.child.send({ input, key, count: index === 2 ? 16 : 17 }),
        );
        const deadline = performance.now() + 2000;
        let waiting = 0;
        while (performance.now() < deadline) {
          const [row] = await db.admin.em
            .fork()
            .execute<Record<string, unknown>[]>(
              "select count(distinct application_name)::integer as waiting from pg_stat_activity where datname=? and application_name like 'duplicates-%' and wait_event_type='Lock'",
              [db.name],
            );
          waiting = row?.waiting as number;
          if (waiting === 3) break;
          await systemFinancialRuntime.sleep(5);
        }
        expect(waiting).toBe(3);
      } finally {
        release();
        await blocker;
      }
      const done = await Promise.all(workers.map((worker) => worker.wait('DONE')));
      const results = done.flatMap((message) => message.results);
      expect(results).toHaveLength(50);
      expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
      expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
      for (const result of results)
        expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' } });
      for (const worker of workers) expect(await worker.child.exited).toBe(0);
      await balance(wallet.id, '75.00', 2);
      expect(await counts(wallet.id)).toEqual({ transactions: 2, ledger: 2, events: 4 });
    } finally {
      for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
      await Promise.all(workers.map((w) => w.child.exited));
    }
  });
  test('PROC-012: independent use-case processes compete for insufficient shared funds', async () => {
    const wallet = await open();
    const other = await open();
    const inputs = [
      command(wallet, 'BET', '80.00'),
      command(wallet, 'BET', '80.00'),
      command(other, 'BET', '10.00'),
    ];
    const workers = inputs.map(() => useCaseRace(db.url));
    try {
      await Promise.all(workers.map((worker) => worker.wait('READY')));
      workers.forEach((worker, i) =>
        worker.child.send({ input: inputs[i], key: randomUUID(), count: 1 }),
      );
      const done = await Promise.all(workers.map((worker) => worker.wait('DONE')));
      expect(
        done
          .slice(0, 2)
          .flatMap((message) => message.results.map((result) => result.status))
          .sort(),
      ).toEqual(['PROCESSED', 'REJECTED']);
      expect(done[2]!.results[0]!.status).toBe('PROCESSED');
      for (const worker of workers) expect(await worker.child.exited).toBe(0);
      await balance(wallet.id, '20.00', 2);
      await balance(other.id, '90.00', 2);
    } finally {
      for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
      await Promise.all(workers.map((w) => w.child.exited));
    }
  });
  test('REV-005: REFUND and ROLLBACK compete in independent processes with one effective reversal', async () => {
    const wallet = await open();
    const bet = command(wallet);
    await processWith().execute(bet, randomUUID());
    const inputs = ['REFUND', 'ROLLBACK'].map((kind) =>
      command(wallet, kind, '25.00', { referenceExternalTransactionId: bet.externalTransactionId }),
    );
    const workers = inputs.map(() => useCaseRace(db.url));
    try {
      await Promise.all(workers.map((worker) => worker.wait('READY')));
      workers.forEach((worker, i) =>
        worker.child.send({ input: inputs[i], key: randomUUID(), count: 1 }),
      );
      const results = (await Promise.all(workers.map((worker) => worker.wait('DONE')))).flatMap(
        (message) => message.results,
      );
      expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
      expect(results.find((result) => result.status === 'REJECTED')?.failureCode).toBe(
        'REFERENCE_ALREADY_REVERSED',
      );
      for (const worker of workers) expect(await worker.child.exited).toBe(0);
      await balance(wallet.id, '100.00', 3);
      expect(await counts(wallet.id)).toEqual({ transactions: 4, ledger: 3, events: 7 });
    } finally {
      for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
      await Promise.all(workers.map((w) => w.child.exited));
    }
  });
  test('a real lock timeout followed by release succeeds in a fresh financial context', async () => {
    const wallet = await open();
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = unit.run(async (p) => {
      await p.lockWallet(wallet.id);
      locked();
      await done;
    });
    await ready;
    const contexts = new Set<FinancialPersistence>();
    const tracked: FinancialUnitOfWork = {
      run: (work) =>
        unit.run((p) => {
          contexts.add(p);
          return work(p);
        }),
    };
    const retryRuntime = {
      ...runtime,
      sleep: async () => {
        release();
        await blocker;
      },
    };
    try {
      const result = await new ProcessTransaction(tracked, retryRuntime, ['provider-a']).execute(
        command(wallet),
        randomUUID(),
      );
      expect(result.status).toBe('PROCESSED');
      expect(contexts.size).toBe(2);
    } finally {
      release();
      await blocker;
    }
    await balance(wallet.id, '75.00', 2);
  });
  test('uppercase UUID inputs retain their hash but compare by UUID identity', async () => {
    const wallet = await open();
    const input = command(wallet, 'BET', '25.00', {
      walletId: wallet.id.toUpperCase(),
      playerId: wallet.playerId.toUpperCase(),
    });
    const key = randomUUID();
    expect(await processWith().execute(input, key)).toMatchObject({ status: 'PROCESSED' });
    expect(await processWith().execute(input, key)).toMatchObject({ idempotentReplay: true });
    await balance(wallet.id, '75.00', 2);
  });
  test('unknown errors are not converted into financial rejections or FAILED', async () => {
    const failure = new Error('Unexpected failure');
    const failing = intercept('findByKey', async () => {
      throw failure;
    });
    const wallet = await open();
    await expect(processWith(failing).execute(command(wallet), randomUUID())).rejects.toBe(failure);
    await balance(wallet.id, '100.00', 1);
  });
});
