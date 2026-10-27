import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createOrm } from '../../src/bootstrap/financial-database';
import { FinancialStorageError } from '../../src/modules/financial/application/financial-error';
import type { FinancialPersistence } from '../../src/modules/financial/application/ports/financial-persistence';
import type { FinancialUnitOfWork } from '../../src/modules/financial/application/ports/financial-unit-of-work';
import { OpenWallet } from '../../src/modules/financial/application/use-cases/open-wallet';
import { ProcessTransaction } from '../../src/modules/financial/application/use-cases/process-transaction';
import { ResumePendingTransaction } from '../../src/modules/financial/application/use-cases/resume-pending-transaction';
import { SchedulePendingReferences } from '../../src/modules/financial/application/use-cases/schedule-pending-references';
import { AwsSqsTransport } from '../../src/modules/financial/infrastructure/messaging/aws-sqs-transport';
import { MikroSqsRecoveryStore } from '../../src/modules/financial/infrastructure/messaging/mikro-sqs-recovery-store';
import { setupSqsQueues } from '../../src/modules/financial/infrastructure/messaging/setup-sqs-queues';
import { MikroFinancialUnitOfWork } from '../../src/modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { MikroPendingReferenceStore } from '../../src/modules/financial/infrastructure/references/mikro-pending-reference-store';
import { systemFinancialRuntime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';
import { HandleSqsDelivery } from '../../src/modules/financial/presentation/sqs/handle-sqs-delivery';
import { sqsClient } from '../../src/platform/messaging/sqs-client';
import { financialTestDatabase } from '../support/financial-test-database';
import { referenceRace } from '../support/reference-race';
import { sqsRace } from '../support/sqs-race';

let db: Awaited<ReturnType<typeof financialTestDatabase>>;
let unit: MikroFinancialUnitOfWork;
let store: MikroPendingReferenceStore;
let time: number;
const runtime = { ...systemFinancialRuntime, now: () => new Date(time), random: () => 0 };
const processor = () => new ProcessTransaction(unit, runtime, ['provider-a']);
const open = () =>
  new OpenWallet(unit, runtime).execute({
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
const input = (
  wallet: { id: string; playerId: string },
  kind = 'BET',
  extra: Record<string, unknown> = {},
) => ({
  providerId: 'provider-a',
  externalTransactionId: randomUUID(),
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId: 'round-1',
  gameId: 'game-1',
  kind,
  money: { amount: '25.00', currency: 'BRL' },
  ...extra,
});
const sql = (query: string, params: unknown[] = []) =>
  db.observer.em.fork().execute<Record<string, unknown>[]>(query, params);
const scheduler = (u: FinancialUnitOfWork = unit) =>
  new SchedulePendingReferences(store, new ResumePendingTransaction(u, runtime), runtime);
async function setup() {
  const wallet = await open();
  const bet = input(wallet);
  const refund = input(wallet, 'REFUND', {
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  const key = randomUUID();
  const pending = await processor().execute(refund, key);
  time += 3000;
  return { wallet, bet, refund, key, pending };
}
async function corruptReference(bet: Record<string, unknown>) {
  const processed = await processor().execute(bet, randomUUID());
  await db.owner.em.fork().transactional(async (em) => {
    await em.execute('alter table financial.wager_transactions disable trigger guard_transaction');
    await em.execute(
      `update financial.wager_transactions set result=jsonb_set(result,'{balance,amount}','"invalid"') where id=?`,
      [processed.transactionId],
    );
    await em.execute('set constraints all immediate');
    await em.execute('alter table financial.wager_transactions enable trigger guard_transaction');
  });
  return processed;
}
function intercept(
  method: keyof FinancialPersistence,
  after: () => Promise<void>,
): FinancialUnitOfWork {
  return {
    run: (work, options) =>
      unit.run(
        (p) =>
          work(
            new Proxy(p, {
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
        options,
      ),
  };
}
async function assertBalance(id: string, amount: string) {
  const [row] = await sql(
    `select w.balance::text as amount,w.balance=coalesce(sum(case when l.direction='CREDIT' then l.amount else -l.amount end),0) as consistent
    from financial.wallets w left join financial.wallet_ledger_entries l on l.wallet_id=w.id where w.id=? group by w.id`,
    [id],
  );
  expect(row).toEqual({ amount, consistent: true });
}
async function snapshot(id: string) {
  return (
    await sql(
      'select status,reference_attempts,next_reference_attempt_at,reference_expires_at,result from financial.wager_transactions where id=?',
      [id],
    )
  )[0]!;
}
beforeEach(async () => {
  time = Date.parse('2026-10-27T18:00:00.000Z');
  db = await financialTestDatabase();
  unit = new MikroFinancialUnitOfWork(db.app);
  store = new MikroPendingReferenceStore(db.app);
}, 30000);
afterEach(async () => {
  if (db) await db.close();
}, 30000);

test('REV-007/010: discovery excludes future work, rechecks once and keeps one pending event', async () => {
  const { wallet, pending } = await setup();
  time -= 3000;
  expect(await scheduler().execute()).toEqual({ selected: 0, completed: 0, incomplete: 0 });
  time += 3000;
  const before = await snapshot(pending.transactionId);
  expect(await scheduler().execute()).toEqual({ selected: 1, completed: 1, incomplete: 0 });
  const after = await snapshot(pending.transactionId);
  expect(after.reference_attempts).toBe(2);
  expect(after.reference_expires_at).toBe(before.reference_expires_at);
  expect(
    await sql('select event_type from financial.outbox_messages where transaction_id=?', [
      pending.transactionId,
    ]),
  ).toEqual([{ event_type: 'WagerTransactionPendingReference' }]);
  expect(await scheduler().execute()).toEqual({ selected: 0, completed: 0, incomplete: 0 });
  await assertBalance(wallet.id, '100.00');
});
test('REV-010/014: expiration rejects with one event, no DLQ or failure diagnostic, and never reopens', async () => {
  const { wallet, pending, bet } = await setup();
  time += 86400000;
  await scheduler().execute();
  expect(await snapshot(pending.transactionId)).toMatchObject({
    status: 'REJECTED',
    result: { failureCode: 'REFERENCE_NOT_FOUND_EXPIRED' },
  });
  await processor().execute(bet, randomUUID());
  await scheduler().execute();
  expect(await snapshot(pending.transactionId)).toMatchObject({ status: 'REJECTED' });
  expect(await store.failures()).toEqual([]);
  expect(await sql('select id from financial.dlq_transfers')).toEqual([]);
  await assertBalance(wallet.id, '75.00');
});
test('REV-011: a reference available after the deadline still processes on restart', async () => {
  const { wallet, pending, bet } = await setup();
  await processor().execute(bet, randomUUID());
  time += 86400000;
  const worker = referenceRace(db.url, new Date(time).toISOString());
  try {
    await worker.wait('READY');
    worker.child.send({ type: 'START' });
    expect(await worker.wait('DONE')).toMatchObject({ completed: 1, incomplete: 0 });
    expect(await worker.child.exited).toBe(0);
  } finally {
    if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
    await worker.child.exited;
  }
  expect(await snapshot(pending.transactionId)).toMatchObject({ status: 'PROCESSED' });
  await assertBalance(wallet.id, '100.00');
});
test('transient, unknown and simulated uncertain commit do not create FAILED or consume another reference attempt', async () => {
  const { wallet, pending, bet } = await setup();
  const before = await snapshot(pending.transactionId);
  for (const error of [
    new FinancialStorageError('TRANSIENT'),
    new Error('Unknown'),
    new FinancialStorageError('UNAVAILABLE'),
  ]) {
    const failing = intercept('findByExternalId', async () => {
      throw error;
    });
    expect((await scheduler(failing).execute()).incomplete).toBe(1);
    expect(await snapshot(pending.transactionId)).toEqual(before);
  }
  time += 10000;
  await processor().execute(bet, randomUUID());
  const uncertain: FinancialUnitOfWork = {
    run: async (work, options) => {
      await unit.run(work, options);
      throw new FinancialStorageError('UNAVAILABLE');
    },
  };
  expect((await scheduler(uncertain).execute()).incomplete).toBe(1);
  expect(await snapshot(pending.transactionId)).toMatchObject({ status: 'PROCESSED' });
  expect(before.reference_attempts).toBe(1);
  expect(await store.failures()).toEqual([]);
  await assertBalance(wallet.id, '100.00');
});
test('PROC-025: a classified corrupt reference produces durable HTTP-only FAILED with replay and immutable audit', async () => {
  const { wallet, pending, bet, refund, key } = await setup();
  await corruptReference(bet);
  const correlation = randomUUID();
  const result = await new ResumePendingTransaction(unit, runtime).execute(
    pending.transactionId,
    correlation,
  );
  expect(result).toMatchObject({
    status: 'FAILED',
    failureCode: 'INVALID_REFERENCE_STATE',
    balance: { amount: '75.00' },
  });
  expect(await store.failures(pending.transactionId)).toMatchObject([
    {
      transaction_id: pending.transactionId,
      failure_code: 'INVALID_REFERENCE_STATE',
      correlation_id: correlation,
    },
  ]);
  expect(await processor().execute(refund, key)).toMatchObject({
    ...result,
    idempotentReplay: true,
    correlationId: expect.any(String),
  });
  expect(await sql('select id from financial.dlq_transfers')).toEqual([]);
  await expect(sql('delete from financial.failure_diagnostics')).rejects.toBeDefined();
  await expect(
    sql('update financial.failure_diagnostics set failure_code=?', ['changed']),
  ).rejects.toBeDefined();
  await assertBalance(wallet.id, '75.00');
});
test('failed diagnostic insertion rolls the entire recovery back to the original pending schedule', async () => {
  const { wallet, pending, bet } = await setup();
  await corruptReference(bet);
  const before = await snapshot(pending.transactionId);
  await db.owner.em.fork().execute('revoke insert on financial.failure_diagnostics from wager_app');
  expect((await scheduler().execute()).incomplete).toBe(1);
  expect(await snapshot(pending.transactionId)).toEqual(before);
  expect(await store.failures()).toEqual([]);
  await assertBalance(wallet.id, '75.00');
});
test('corruption of the target remains pending and never masquerades as a classified reference fault', async () => {
  const { wallet, pending } = await setup();
  await db.owner.em.fork().transactional(async (em) => {
    await em.execute('alter table financial.wager_transactions disable trigger guard_transaction');
    await em.execute(
      `update financial.wager_transactions set result=jsonb_set(result,'{balance,amount}','"invalid"') where id=?`,
      [pending.transactionId],
    );
    await em.execute('set constraints all immediate');
    await em.execute('alter table financial.wager_transactions enable trigger guard_transaction');
  });
  expect((await scheduler().execute()).incomplete).toBe(1);
  expect(await store.failures()).toEqual([]);
  expect(await snapshot(pending.transactionId)).toMatchObject({
    status: 'PENDING_REFERENCE',
    reference_attempts: 1,
  });
  await assertBalance(wallet.id, '100.00');
});

test.each(['available', 'missing'])(
  'REV-012: three schedulers revalidate a %s reference while another wallet advances',
  async (availability) => {
    const first = await setup();
    if (availability === 'available') await processor().execute(first.bet, randomUUID());
    const other = await setup();
    await processor().execute(other.bet, randomUUID());
    const workers = [0, 1, 2].map((index) => {
      const url = new URL(db.url);
      url.searchParams.set('application_name', `reference-race-${index}`);
      return referenceRace(url.href, new Date(time).toISOString());
    });
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = unit.run(async (p) => {
      await p.lockWallet(first.wallet.id);
      locked();
      await gate;
    });
    await ready;
    try {
      const states = await Promise.all(workers.map((worker) => worker.wait('READY')));
      expect(new Set(states.map((row) => row.pid)).size).toBe(3);
      workers.forEach((worker) => worker.child.send({ type: 'START' }));
      let waiting = 0;
      let otherStatus: unknown;
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline) {
        const [row] = await db.admin.em.fork().execute<{ waiting: number }[]>(
          `select count(distinct application_name)::integer as waiting
        from pg_stat_activity where datname=? and application_name like 'reference-race-%' and wait_event_type='Lock'`,
          [db.name],
        );
        waiting = row!.waiting;
        otherStatus = (await snapshot(other.pending.transactionId)).status;
        if (waiting === 3 && otherStatus === 'PROCESSED') break;
        await runtime.sleep(5);
      }
      expect(waiting).toBe(3);
      expect(otherStatus).toBe('PROCESSED');
      release();
      await blocker;
      for (const worker of workers) {
        expect(await worker.wait('DONE')).toMatchObject({ incomplete: 0 });
        expect(await worker.child.exited).toBe(0);
      }
      expect(await snapshot(first.pending.transactionId)).toMatchObject({
        status: availability === 'available' ? 'PROCESSED' : 'PENDING_REFERENCE',
        reference_attempts: availability === 'available' ? 1 : 2,
      });
      expect(
        await sql(
          `select count(*)::integer as count from financial.wallet_ledger_entries where transaction_id in (?,?)`,
          [first.pending.transactionId, other.pending.transactionId],
        ),
      ).toEqual([{ count: availability === 'available' ? 2 : 1 }]);
      await assertBalance(first.wallet.id, '100.00');
      await assertBalance(other.wallet.id, '100.00');
    } finally {
      release();
      await blocker;
      for (const worker of workers)
        if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
      await Promise.all(workers.map((worker) => worker.child.exited));
    }
  },
  15000,
);
test.each(['before-commit', 'after-commit'])(
  'REV-011/013: SIGKILL %s and a new scheduler retain exactly one financial effect',
  async (mode) => {
    const { wallet, pending, bet } = await setup();
    await processor().execute(bet, randomUUID());
    const worker = referenceRace(db.url, new Date(time).toISOString(), mode);
    try {
      await worker.wait('READY');
      worker.child.send({ type: 'START' });
      await worker.wait(mode === 'before-commit' ? 'FLUSHED' : 'COMMITTED');
      worker.child.kill('SIGKILL');
      await worker.child.exited;
      expect((await snapshot(pending.transactionId)).status).toBe(
        mode === 'before-commit' ? 'PENDING_REFERENCE' : 'PROCESSED',
      );
      const restarted = referenceRace(db.url, new Date(time).toISOString());
      try {
        await restarted.wait('READY');
        restarted.child.send({ type: 'START' });
        await restarted.wait('DONE');
        expect(await restarted.child.exited).toBe(0);
      } finally {
        if (restarted.child.exitCode === null) restarted.child.kill('SIGKILL');
        await restarted.child.exited;
      }
      expect((await snapshot(pending.transactionId)).status).toBe('PROCESSED');
      expect(
        await sql(
          'select count(*)::integer as count from financial.wallet_ledger_entries where transaction_id=?',
          [pending.transactionId],
        ),
      ).toEqual([{ count: 1 }]);
      await assertBalance(wallet.id, '100.00');
    } finally {
      if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
      await worker.child.exited;
    }
  },
);
test.each([true, false])(
  'repaired reference after rollback, concurrent terminal winner=%s, never gets false FAILED',
  async (winner) => {
    const { wallet, pending, bet } = await setup();
    const processed = await corruptReference(bet);
    const worker = referenceRace(db.url, new Date(time).toISOString(), 'after-rollback');
    try {
      await worker.wait('READY');
      worker.child.send({ type: 'START' });
      await worker.wait('ROLLED_BACK');
      await db.owner.em.fork().transactional(async (em) => {
        await em.execute(
          'alter table financial.wager_transactions disable trigger guard_transaction',
        );
        await em.execute(
          `update financial.wager_transactions set result=jsonb_set(result,'{balance,amount}','"75.00"') where id=?`,
          [processed.transactionId],
        );
        await em.execute('set constraints all immediate');
        await em.execute(
          'alter table financial.wager_transactions enable trigger guard_transaction',
        );
      });
      if (winner)
        expect(
          await new ResumePendingTransaction(unit, runtime).execute(pending.transactionId),
        ).toMatchObject({ status: 'PROCESSED' });
      worker.child.send({ type: 'RELEASE' });
      expect(await worker.wait('DONE')).toMatchObject({ incomplete: 0 });
      expect(await worker.child.exited).toBe(0);
      expect(await store.failures()).toEqual([]);
      await scheduler().execute();
      expect((await snapshot(pending.transactionId)).status).toBe('PROCESSED');
      await assertBalance(wallet.id, '100.00');
    } finally {
      if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
      await worker.child.exited;
    }
  },
);

async function sqsPending() {
  const client = sqsClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    local: true,
  });
  const suffix = randomUUID();
  const queues = await setupSqsQueues(
    client,
    `reference-test-${suffix}.fifo`,
    `reference-test-dlq-${suffix}.fifo`,
  );
  const close = async () => {
    try {
      await client.send(new DeleteQueueCommand({ QueueUrl: queues.input }));
    } finally {
      try {
        await client.send(new DeleteQueueCommand({ QueueUrl: queues.dlq }));
      } finally {
        client.destroy();
      }
    }
  };
  try {
    const transport = new AwsSqsTransport(client, queues.input);
    const data = await setup();
    const body = JSON.stringify({
      messageId: randomUUID(),
      type: 'WagerTransactionRequested',
      occurredAt: runtime.now().toISOString(),
      data: { ...data.refund, idempotencyKey: data.key },
    });
    const recovery = new MikroSqsRecoveryStore(db.app);
    const handler = new HandleSqsDelivery(processor(), recovery, runtime, queues.input, queues.dlq);
    await transport.send(queues.input, body, data.wallet.id, randomUUID());
    const [delivery] = await transport.receive(1, 0, 60);
    if (!delivery) throw new Error('Expected original delivery');
    expect(await handler.execute(delivery)).toEqual({ acknowledge: true, transferId: undefined });
    await transport.acknowledge(delivery.receiptHandle);
    await corruptReference(data.bet);
    return { ...data, body, client, queues, transport, close };
  } catch (error: unknown) {
    await close();
    throw error;
  }
}

test('REV-020/PROC-024: ACKed SQS origin, automatic FAILED, SIGKILL and a separate dispatcher preserve the original body', async () => {
  const data = await sqsPending();
  const worker = referenceRace(db.url, new Date(time).toISOString(), 'after-commit');
  try {
    await worker.wait('READY');
    worker.child.send({ type: 'START' });
    await worker.wait('COMMITTED');
    worker.child.kill('SIGKILL');
    await worker.child.exited;
    expect(await snapshot(data.pending.transactionId)).toMatchObject({ status: 'FAILED' });
    expect(await data.transport.receive(1, 0, 1)).toEqual([]);
    const dispatcher = sqsRace(db.url, data.queues.input, data.queues.dlq, 'dispatch');
    try {
      await dispatcher.wait('READY');
      dispatcher.child.send({ type: 'START' });
      await dispatcher.wait('DONE');
      expect(await dispatcher.child.exited).toBe(0);
    } finally {
      if (dispatcher.child.exitCode === null) dispatcher.child.kill('SIGKILL');
      await dispatcher.child.exited;
    }
    const received = await new AwsSqsTransport(data.client, data.queues.dlq).receive(1, 0, 60);
    expect(received[0]?.body).toBe(data.body);
    expect(
      await sql(
        'select reason,dlq_confirmed_at is not null as confirmed from financial.dlq_transfers',
      ),
    ).toEqual([{ reason: 'PENDING_REFERENCE_FAILED', confirmed: true }]);
    expect(await store.failures()).toHaveLength(1);
    await assertBalance(data.wallet.id, '75.00');
  } finally {
    if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
    await worker.child.exited;
    await data.close();
  }
});
test.each(['before-send', 'after-send'] as const)(
  'SQS-025: SIGKILL %s of the late DLQ transfer retains one durable responsibility',
  async (phase) => {
    const data = await sqsPending();
    let first: ReturnType<typeof sqsRace> | undefined;
    let restarted: ReturnType<typeof sqsRace> | undefined;
    try {
      expect((await scheduler().execute()).incomplete).toBe(0);
      expect(await snapshot(data.pending.transactionId)).toMatchObject({ status: 'FAILED' });
      expect(await data.transport.receive(1, 0, 1)).toEqual([]);
      const [initial] = await sql('select id,body,attempts from financial.dlq_transfers');
      expect(initial?.body).toBe(data.body);
      first = sqsRace(db.url, data.queues.input, data.queues.dlq, `dispatch-${phase}`);
      await first.wait('READY');
      first.child.send({ type: 'START' });
      const sent = await first.wait(phase === 'before-send' ? 'DLQ_BEFORE_SEND' : 'DLQ_SENT');
      expect(sent.transferId).toBe(String(initial!.id));
      expect(
        await sql('select id from financial.dlq_transfers where dlq_confirmed_at is not null'),
      ).toEqual([]);
      first.child.kill('SIGKILL');
      await first.child.exited;
      let expired = false;
      const deadline = performance.now() + 4000;
      while (performance.now() < deadline) {
        const [lease] = await sql(
          'select lease_until<=clock_timestamp() as expired from financial.dlq_transfers where id=?',
          [initial!.id],
        );
        if (lease?.expired) {
          expired = true;
          break;
        }
        await runtime.sleep(10);
      }
      expect(expired).toBe(true);
      restarted = sqsRace(db.url, data.queues.input, data.queues.dlq, 'dispatch');
      await restarted.wait('READY');
      restarted.child.send({ type: 'START' });
      await restarted.wait('DONE');
      expect(await restarted.child.exited).toBe(0);
      expect(
        await sql(
          'select id,body,dlq_confirmed_at is not null as confirmed from financial.dlq_transfers',
        ),
      ).toEqual([{ id: initial!.id, body: data.body, confirmed: true }]);
      const [delivery] = await new AwsSqsTransport(data.client, data.queues.dlq).receive(1, 0, 60);
      expect(delivery?.body).toBe(data.body);
      expect(await store.failures()).toHaveLength(1);
      await assertBalance(data.wallet.id, '75.00');
    } finally {
      for (const worker of [first, restarted])
        if (worker?.child.exitCode === null) worker.child.kill('SIGKILL');
      await Promise.all([first?.child.exited, restarted?.child.exited]);
      await data.close();
    }
  },
  15000,
);
test('REV-021: failure to insert the late DLQ task rolls FAILED and its diagnostic back together', async () => {
  const data = await sqsPending();
  try {
    const before = await snapshot(data.pending.transactionId);
    await db.owner.em.fork().execute('revoke insert on financial.dlq_transfers from wager_app');
    expect((await scheduler().execute()).incomplete).toBe(1);
    expect(await snapshot(data.pending.transactionId)).toEqual(before);
    expect(await store.failures()).toEqual([]);
    expect(await sql('select id from financial.dlq_transfers')).toEqual([]);
    await db.owner.em.fork().execute('grant insert on financial.dlq_transfers to wager_app');
    expect((await scheduler().execute()).incomplete).toBe(0);
    expect(await snapshot(data.pending.transactionId)).toMatchObject({ status: 'FAILED' });
    expect(await store.failures()).toHaveLength(1);
    expect(await sql('select id from financial.dlq_transfers')).toHaveLength(1);
    await assertBalance(data.wallet.id, '75.00');
  } finally {
    await data.close();
  }
});

test('lost connection before rollback acknowledgement cannot certify FAILED', async () => {
  const { wallet, pending, bet } = await setup();
  await corruptReference(bet);
  const before = await snapshot(pending.transactionId);
  const url = new URL(db.url);
  url.searchParams.set('application_name', 'reference-rollback-loss');
  const orm = await createOrm(url.href);
  const base = new MikroFinancialUnitOfWork(orm);
  let terminated = false;
  const losing: FinancialUnitOfWork = {
    run: (work, options) =>
      base.run(
        (p) =>
          work(
            new Proxy(p, {
              get(target, property) {
                const value = Reflect.get(target, property);
                if (typeof value !== 'function') return value;
                return async (...args: unknown[]) => {
                  try {
                    return await value.apply(target, args);
                  } catch (error: unknown) {
                    if (property === 'findByExternalId' && !terminated) {
                      terminated = true;
                      const rows = await db.admin.em.fork().execute<{ terminated: boolean }[]>(
                        `select pg_terminate_backend(pid) as terminated from pg_stat_activity
            where datname=? and application_name='reference-rollback-loss' and state='idle in transaction'`,
                        [db.name],
                      );
                      expect(rows).toEqual([{ terminated: true }]);
                    }
                    throw error;
                  }
                };
              },
            }),
          ),
        options,
      ),
  };
  try {
    expect((await scheduler(losing).execute()).incomplete).toBe(1);
    expect(terminated).toBe(true);
    expect(await snapshot(pending.transactionId)).toEqual(before);
    expect(await store.failures()).toEqual([]);
    await assertBalance(wallet.id, '75.00');
  } finally {
    await orm.close(true);
  }
});
test('recovery refuses a corrupt pending row that already has a ledger effect', async () => {
  const { wallet, pending, bet } = await setup();
  await corruptReference(bet);
  // Isolated corruption fixture: preserve the numeric ledger sum while reassigning
  // the opening effect to the pending identity. Normal application privileges forbid this.
  await db.owner.em.fork().transactional(async (em) => {
    await em.execute('alter table financial.wallet_ledger_entries disable trigger user');
    await em.execute(
      `update financial.wallet_ledger_entries set transaction_id=? where wallet_id=? and wallet_version=1`,
      [pending.transactionId, wallet.id],
    );
    await em.execute('set constraints all immediate');
    await em.execute('alter table financial.wallet_ledger_entries enable trigger user');
  });
  const before = await snapshot(pending.transactionId);
  expect((await scheduler().execute()).incomplete).toBe(1);
  expect(await snapshot(pending.transactionId)).toEqual(before);
  expect(await store.failures()).toEqual([]);
  await assertBalance(wallet.id, '75.00');
});
test('failure diagnostics reject fabricated facts and the discovery cursor preserves PostgreSQL microseconds', async () => {
  const items = [await setup(), await setup(), await setup()];
  for (const item of items)
    await db.owner.em
      .fork()
      .execute(
        `update financial.wager_transactions set next_reference_attempt_at='2026-10-27T18:00:00.000123Z' where id=?`,
        [item.pending.transactionId],
      );
  const first = await store.due(runtime.now(), 2);
  expect(first).toHaveLength(2);
  expect(first[0]?.nextAttemptAt).toBe('2026-10-27T18:00:00.000123Z');
  const next = await store.due(runtime.now(), 2, first[1]);
  expect(next).toHaveLength(1);
  expect(new Set([...first, ...next].map((row) => row.id)).size).toBe(3);
  await expect(
    sql(
      `insert into financial.failure_diagnostics(transaction_id,failure_code,correlation_id,failed_at) values(?,?,?,?)`,
      [items[0]!.pending.transactionId, 'invented', randomUUID(), runtime.now()],
    ),
  ).rejects.toBeDefined();
  for (const item of items) await assertBalance(item.wallet.id, '100.00');
});

test('SIGTERM drains an admitted reference operation before exiting', async () => {
  const { wallet, pending, bet } = await setup();
  await processor().execute(bet, randomUUID());
  const worker = referenceRace(db.url, new Date(time).toISOString(), 'before-commit');
  try {
    await worker.wait('READY');
    worker.child.send({ type: 'START' });
    await worker.wait('FLUSHED');
    worker.child.kill('SIGTERM');
    expect(worker.child.exitCode).toBeNull();
    worker.child.send({ type: 'RELEASE' });
    expect(await worker.wait('DONE')).toMatchObject({ completed: 1, incomplete: 0 });
    expect(await worker.child.exited).toBe(0);
    expect(await snapshot(pending.transactionId)).toMatchObject({ status: 'PROCESSED' });
    await assertBalance(wallet.id, '100.00');
  } finally {
    if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
    await worker.child.exited;
  }
});
