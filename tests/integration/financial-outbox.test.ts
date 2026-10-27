import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type {
  EventPublicationTransport,
  FinancialOutboxStore,
  OutboxDiagnostic,
} from '../../src/modules/financial/application/ports/financial-outbox-store';
import { OpenWallet } from '../../src/modules/financial/application/use-cases/open-wallet';
import { ProcessTransaction } from '../../src/modules/financial/application/use-cases/process-transaction';
import { PublishOutbox } from '../../src/modules/financial/application/use-cases/publish-outbox';
import { ResumePendingTransaction } from '../../src/modules/financial/application/use-cases/resume-pending-transaction';
import { MikroFinancialOutboxStore } from '../../src/modules/financial/infrastructure/events/mikro-financial-outbox-store';
import { SqsEventPublication } from '../../src/modules/financial/infrastructure/events/sqs-event-publication';
import { AwsSqsTransport } from '../../src/modules/financial/infrastructure/messaging/aws-sqs-transport';
import { setupSqsQueues } from '../../src/modules/financial/infrastructure/messaging/setup-sqs-queues';
import { MikroFinancialUnitOfWork } from '../../src/modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { systemFinancialRuntime as runtime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';
import { sqsClient } from '../../src/platform/messaging/sqs-client';
import { EventTestConsumer, prepareEventConsumer } from '../support/event-test-consumer';
import { financialTestDatabase } from '../support/financial-test-database';
import { outboxRace } from '../support/outbox-race';

const client = sqsClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
  local: true,
});
let db: Awaited<ReturnType<typeof financialTestDatabase>>;
let queues: Awaited<ReturnType<typeof setupSqsQueues>>;
let store: MikroFinancialOutboxStore;
let transport: AwsSqsTransport;
let sender: SqsEventPublication;
let unit: MikroFinancialUnitOfWork;
const logs: OutboxDiagnostic[] = [];
const publisher = (
  outbound: EventPublicationTransport = sender,
  policy: ConstructorParameters<typeof PublishOutbox>[3] = {},
  outbox: FinancialOutboxStore = store,
) => new PublishOutbox(outbox, outbound, runtime, policy, (record) => logs.push(record));
const open = (amount = '100.00') =>
  new OpenWallet(unit, runtime).execute({
    playerId: randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
  });
async function move(wallet: { id: string; playerId: string }, kind = 'BET', amount = '25.00') {
  return new ProcessTransaction(unit, runtime, ['provider-a']).execute(
    {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round',
      gameId: 'game',
      kind,
      money: { amount, currency: 'BRL' },
    },
    randomUUID(),
  );
}
async function balance(walletId: string, expected: string) {
  const [row] = await db.observer.em.fork().execute(
    `select w.balance::text as amount,
    w.balance=coalesce(sum(case when l.direction='CREDIT' then l.amount else -l.amount end),0) as consistent
    from financial.wallets w left join financial.wallet_ledger_entries l on l.wallet_id=w.id where w.id=? group by w.id`,
    [walletId],
  );
  expect(row).toEqual({ amount: expected, consistent: true });
}
async function events() {
  return db.observer.em
    .fork()
    .execute<Record<string, unknown>[]>(
      'select * from financial.outbox_messages order by occurred_at,id',
    );
}
async function receiveAll(expected: number): Promise<string[]> {
  const bodies: string[] = [];
  const deadline = performance.now() + 4000;
  while (bodies.length < expected && performance.now() < deadline) {
    const received = await transport.receive(10, 0, 60);
    for (const message of received) {
      bodies.push(message.body);
      await transport.acknowledge(message.receiptHandle);
    }
    if (!received.length) await runtime.sleep(10);
  }
  expect(bodies).toHaveLength(expected);
  return bodies;
}
async function expireClaims() {
  await db.owner.em
    .fork()
    .execute(
      "update financial.outbox_messages set lease_until=clock_timestamp()-interval '1 second' where published_at is null and claim_token is not null",
    );
}

beforeEach(async () => {
  db = await financialTestDatabase();
  const suffix = randomUUID();
  queues = await setupSqsQueues(client, `outbox-test-${suffix}.fifo`, `outbox-dlq-${suffix}.fifo`);
  store = new MikroFinancialOutboxStore(db.app);
  unit = new MikroFinancialUnitOfWork(db.app);
  transport = new AwsSqsTransport(client, queues.input);
  sender = new SqsEventPublication(transport, queues.input);
  logs.length = 0;
}, 30000);
afterEach(async () => {
  if (queues) {
    await client.send(new DeleteQueueCommand({ QueueUrl: queues.input }));
    await client.send(new DeleteQueueCommand({ QueueUrl: queues.dlq }));
  }
  if (db) await db.close();
}, 30000);
afterAll(() => client.destroy());

describe('Financial outbox publisher — PostgreSQL + LocalStack', () => {
  test('EVT-001: uncommitted events cannot be claimed and rollback never publishes', async () => {
    let release!: () => void;
    let flushed!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      flushed = resolve;
    });
    const failure = new Error('Rollback after flush');
    const wrapped = {
      run: <T>(work: Parameters<typeof unit.run<T>>[0]) =>
        unit.run((p) =>
          work(
            new Proxy(p, {
              get(target, key) {
                const value = Reflect.get(target, key);
                if (typeof value !== 'function') return value;
                return async (...args: unknown[]) => {
                  const result = await value.apply(target, args);
                  if (key === 'appendMovement') {
                    flushed();
                    await gate;
                    throw failure;
                  }
                  return result;
                };
              },
            }),
          ),
        ),
    };
    const creating = new OpenWallet(wrapped, runtime).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const failed = creating.then(
      () => undefined,
      (error: unknown) => error,
    );
    await ready;
    try {
      expect(await publisher().execute()).toEqual({ claimed: 0, published: 0 });
    } finally {
      release();
      expect(await failed).toBe(failure);
    }
    expect(await events()).toHaveLength(0);
    expect(await transport.receive(1, 0, 1)).toHaveLength(0);
  });
  test('EVT-002/009: committed opening, LOSS and rejection publish exact stored envelopes', async () => {
    const empty = await open('0.00');
    expect(await publisher().execute()).toEqual({ claimed: 0, published: 0 });
    const wallet = await open();
    await move(wallet, 'LOSS', '0.00');
    await move(wallet, 'BET', '150.00');
    const expected = await events();
    expect(expected).toHaveLength(4);
    expect(await publisher().execute()).toEqual({ claimed: 4, published: 4 });
    const received = (await receiveAll(4)).map((body) => JSON.parse(body));
    expect(new Set(received.map((body) => body.eventId))).toEqual(
      new Set(expected.map((row) => row.id)),
    );
    for (const body of received)
      expect(body).toEqual(expected.find((row) => row.id === body.eventId)!.payload);
    expect(received.filter((body) => body.eventType === 'WalletBalanceChanged')).toHaveLength(1);
    expect((await store.inspect()).every((row) => row.published)).toBe(true);
    await balance(wallet.id, '100.00');
    await balance(empty.id, '0.00');
  });
  test('EVT-003/005: independent claims split the set and stale tokens cannot confirm', async () => {
    const wallet = await open();
    await move(wallet, 'WIN', '10.00');
    const other = new MikroFinancialOutboxStore(db.observer);
    const [left, right] = await Promise.all([store.claim(2, 30000), other.claim(2, 30000)]);
    expect(left).toHaveLength(2);
    expect(right).toHaveLength(2);
    expect(new Set([...left, ...right].map((claim) => claim.id)).size).toBe(4);
    await expireClaims();
    const reclaimed = await other.claim(10, 30000);
    expect(reclaimed).toHaveLength(4);
    expect(await store.confirm(left[0]!.id, left[0]!.claimToken)).toBe(false);
    expect(await store.renew(left[0]!.id, left[0]!.claimToken, 30000)).toBe(false);
    expect(await store.fail(left[0]!.id, left[0]!.claimToken, 1, 10)).toBeNull();
    await balance(wallet.id, '110.00');
  });
  test('EVT-006/007/008: failures back off, suspend and resume with an immutable event and audit', async () => {
    const wallet = await open();
    const original = await events();
    const unavailable = queues.input.replace(/[^/]+$/, 'missing-event-destination.fifo');
    const fail = new SqsEventPublication(transport, unavailable);
    const publishing = publisher(fail, { baseDelayMilliseconds: 1, maxDelayMilliseconds: 1 });
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(await publishing.execute()).toEqual({ claimed: 2, published: 0 });
      if (attempt < 9)
        await db.owner.em
          .fork()
          .execute(
            'update financial.outbox_messages set next_attempt_at=clock_timestamp() where suspended_at is null',
          );
    }
    expect(
      (await store.inspect()).every(
        (row) => row.suspended && row.lastErrorCode === 'SQS_SEND_FAILED',
      ),
    ).toBe(true);
    expect(publishing.counters()).toMatchObject({ sendFailures: 20, suspended: 2 });
    for (const event of original)
      expect(await store.resume(event.id as string, 'local-operator')).toBe(true);
    expect(await publisher().execute()).toEqual({ claimed: 2, published: 2 });
    expect((await receiveAll(2)).map((body) => JSON.parse(body).eventId).sort()).toEqual(
      original.map((event) => event.id).sort(),
    );
    const audit = await db.observer.em
      .fork()
      .execute('select operator from financial.outbox_resume_audit');
    expect(audit).toEqual([{ operator: 'local-operator' }, { operator: 'local-operator' }]);
    for (const current of await events())
      expect(current.payload).toEqual(original.find((event) => event.id === current.id)!.payload);
    expect(logs.some((record) => record.event === 'outbox_suspended')).toBe(true);
    expect(JSON.stringify(logs)).not.toMatch(/100.00|SQS unavailable|password|postgresql/);
    await balance(wallet.id, '100.00');
  });
  test('EVT-004: accepted send with lost response retries the same event and persistent consumer deduplicates', async () => {
    const wallet = await open();
    await prepareEventConsumer(db.owner);
    const consumer = new EventTestConsumer(db.app);
    let lost = false;
    const uncertain = {
      send: async (body: string, group: string, id: string) => {
        await sender.send(body, group, id);
        if (!lost) {
          lost = true;
          throw new Error('Accepted response lost');
        }
      },
    };
    await publisher(uncertain, { baseDelayMilliseconds: 1, maxDelayMilliseconds: 1 }).execute();
    const before = await events();
    expect(before.filter((row) => row.published_at === null)).toHaveLength(1);
    const bodies = await receiveAll(2);
    for (const body of bodies) expect(await consumer.receive(body)).toBe(true);
    await db.owner.em
      .fork()
      .execute(
        'update financial.outbox_messages set next_attempt_at=clock_timestamp() where published_at is null',
      );
    expect(await publisher().execute()).toEqual({ claimed: 1, published: 1 });
    const duplicate = before.find((row) => row.published_at === null)!;
    const duplicateBody = JSON.stringify(duplicate.payload);
    // Override broker deduplication to prove the consumer inbox, independently of SQS's time window.
    await transport.send(
      queues.input,
      duplicateBody,
      duplicate.aggregate_id as string,
      randomUUID(),
    );
    const delivered = await receiveAll(1);
    expect(await new EventTestConsumer(db.observer).receive(delivered[0]!)).toBe(false);
    const inbox = await db.observer.em
      .fork()
      .execute('select event_id from public.test_event_inbox');
    expect(inbox).toHaveLength(2);
    await balance(wallet.id, '100.00');
  });
  test('EVT-012: a projection accepts newer versions and ignores late or duplicate older events', async () => {
    const wallet = await open();
    await move(wallet, 'BET', '25.00');
    await move(wallet, 'WIN', '10.00');
    await prepareEventConsumer(db.owner);
    await publisher().execute();
    const received = await receiveAll(6);
    const ordered = received
      .map((body) => ({ body, event: JSON.parse(body) }))
      .sort((a, b) => (b.event.data.walletVersion ?? 0) - (a.event.data.walletVersion ?? 0));
    const consumer = new EventTestConsumer(db.app);
    for (const item of ordered) await consumer.receive(item.body);
    await new EventTestConsumer(db.observer).receive(ordered.at(-1)!.body);
    const [projection] = await db.observer.em
      .fork()
      .execute(
        'select version::text,balance from public.test_wallet_projection where wallet_id=?',
        [wallet.id],
      );
    expect(projection).toEqual({ version: '3', balance: '85.00' });
    await balance(wallet.id, '85.00');
  });
  test('EVT-014: publication cannot be reopened and event data cannot be rewritten', async () => {
    const wallet = await open();
    await expect(
      db.app.em
        .fork()
        .execute('update financial.outbox_messages set published_at=clock_timestamp()'),
    ).rejects.toMatchObject({ code: '23514' });
    await publisher().execute();
    await expect(
      db.app.em.fork().execute('update financial.outbox_messages set published_at=null'),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.app.em.fork().execute("update financial.outbox_messages set payload='{}'::jsonb"),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.app.em.fork().execute('delete from financial.outbox_messages'),
    ).rejects.toMatchObject({ code: '42501' });
    await balance(wallet.id, '100.00');
  });
  test('invalid envelopes are suspended without sending or rewriting the stored fact', async () => {
    const wallet = await open();
    const original = await events();
    const id = original[0]!.id as string;
    await db.owner.em.fork().transactional(async (em) => {
      await em.execute('alter table financial.outbox_messages disable trigger user');
      await em.execute(
        "update financial.outbox_messages set payload=payload-'correlationId' where id=?",
        [id],
      );
      await em.execute('alter table financial.outbox_messages enable trigger user');
    });
    const result = await publisher().execute();
    expect(result).toEqual({ claimed: 2, published: 1 });
    expect((await store.inspect(id))[0]).toMatchObject({
      suspended: true,
      published: false,
      lastErrorCode: 'INVALID_EVENT_ENVELOPE',
    });
    const current = (await events()).find((event) => event.id === id)!;
    expect(current.payload).not.toHaveProperty('correlationId');
    await balance(wallet.id, '100.00');
  });
  test('heartbeat renewals retain a slow in-flight publication and stop drains admitted sends', async () => {
    const wallet = await open();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let renewed!: () => void;
    const renewals = new Promise<void>((resolve) => {
      renewed = resolve;
    });
    let calls = 0;
    const tracked = new Proxy(store, {
      get(target, key) {
        const method = Reflect.get(target, key);
        if (typeof method !== 'function') return method;
        return async (...args: unknown[]) => {
          const result = await method.apply(target, args);
          if (key === 'renew' && ++calls >= 14) renewed();
          return result;
        };
      },
    });
    const slow = {
      send: async (body: string, group: string, id: string) => {
        entered();
        await gate;
        await sender.send(body, group, id);
      },
    };
    const publishing = publisher(
      slow,
      { leaseMilliseconds: 400, heartbeatMilliseconds: 100 },
      tracked,
    );
    const work = publishing.execute();
    await ready;
    try {
      await renewals;
      expect(await new MikroFinancialOutboxStore(db.observer).claim(10, 30000)).toHaveLength(0);
      publishing.stop();
    } finally {
      release();
    }
    expect(await work).toEqual({ claimed: 2, published: 2 });
    expect(await publishing.execute()).toEqual({ claimed: 0, published: 0 });
    await balance(wallet.id, '100.00');
  });
  test('EVT-002/003: two publisher processes advance committed events while one holds its claim', async () => {
    const wallet = await open();
    await move(wallet, 'WIN', '10.00');
    const held = outboxRace(db.url, queues.input, 'before-send');
    const other = outboxRace(db.url, queues.input);
    try {
      const ready = await Promise.all([held.wait('READY'), other.wait('READY')]);
      expect(ready[0]!.pid).not.toBe(ready[1]!.pid);
      held.child.send({ type: 'START' });
      const claimed = await held.wait('CLAIMED');
      other.child.send({ type: 'START' });
      expect((await other.wait('DONE')).published).toBe(3);
      expect(await other.child.exited).toBe(0);
      expect((await events()).find((row) => row.id === claimed.eventId)!.published_at).toBeNull();
      held.child.send({ type: 'RELEASE' });
      await held.wait('DONE');
      expect(await held.child.exited).toBe(0);
      expect((await store.inspect()).every((event) => event.published)).toBe(true);
      await receiveAll(4);
      await balance(wallet.id, '110.00');
    } finally {
      for (const worker of [held, other]) if (worker.child.exitCode === null) worker.child.kill();
      await Promise.all([held.child.exited, other.child.exited]);
    }
  });
  test.each(['before-send', 'after-send'])(
    'EVT-002/004: SIGKILL at %s is recovered by a new publisher process',
    async (mode) => {
      const wallet = await open();
      await prepareEventConsumer(db.owner);
      const killed = outboxRace(db.url, queues.input, mode);
      let eventId: string;
      try {
        await killed.wait('READY');
        killed.child.send({ type: 'START' });
        eventId = (await killed.wait(mode === 'before-send' ? 'CLAIMED' : 'SENT')).eventId!;
        expect((await events()).find((row) => row.id === eventId)!.published_at).toBeNull();
        killed.child.kill('SIGKILL');
        await killed.child.exited;
      } finally {
        if (killed.child.exitCode === null) killed.child.kill();
      }
      const deadline = performance.now() + 4000;
      let expired = false;
      while (performance.now() < deadline) {
        const [row] = await db.observer.em
          .fork()
          .execute(
            'select lease_until<=clock_timestamp() as expired from financial.outbox_messages where id=?',
            [eventId!],
          );
        if (row?.expired) {
          expired = true;
          break;
        }
        await runtime.sleep(10);
      }
      expect(expired).toBe(true);
      const restarted = outboxRace(db.url, queues.input);
      try {
        await restarted.wait('READY');
        restarted.child.send({ type: 'START' });
        await restarted.wait('DONE');
        expect(await restarted.child.exited).toBe(0);
      } finally {
        if (restarted.child.exitCode === null) restarted.child.kill();
        await restarted.child.exited;
      }
      const received = await receiveAll(2);
      const consumer = new EventTestConsumer(db.app);
      for (const body of received) expect(await consumer.receive(body)).toBe(true);
      const persisted = (await events()).find((row) => row.id === eventId)!;
      await transport.send(
        queues.input,
        JSON.stringify(persisted.payload),
        wallet.id,
        randomUUID(),
      );
      const duplicate = await receiveAll(1);
      expect(await new EventTestConsumer(db.observer).receive(duplicate[0]!)).toBe(false);
      expect((await store.inspect()).every((row) => row.published)).toBe(true);
      await balance(wallet.id, '100.00');
    },
  );
  test('EVT-013: SIGTERM drains an in-flight send and leaves the rest reclaimable', async () => {
    const wallet = await open();
    const stopping = outboxRace(db.url, queues.input, 'after-send');
    try {
      await stopping.wait('READY');
      stopping.child.send({ type: 'START' });
      await stopping.wait('SENT');
      stopping.child.kill('SIGTERM');
      expect(stopping.child.exitCode).toBeNull();
      stopping.child.send({ type: 'RELEASE' });
      await stopping.wait('DONE');
      expect(await stopping.child.exited).toBe(0);
      expect((await store.inspect()).filter((event) => event.published)).toHaveLength(1);
      expect(await publisher().execute()).toEqual({ claimed: 1, published: 1 });
      await receiveAll(2);
      await balance(wallet.id, '100.00');
    } finally {
      if (stopping.child.exitCode === null) stopping.child.kill();
      await stopping.child.exited;
    }
  });
  test('EVT-009/010: pending and completion facts remain distinct and replay creates no new events', async () => {
    const wallet = await open();
    const process = new ProcessTransaction(unit, runtime, ['provider-a']);
    const reference = randomUUID();
    const input = {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round',
      gameId: 'game',
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: reference,
    };
    const key = randomUUID();
    const pending = await process.execute(input, key);
    await process.execute(input, key);
    const { referenceExternalTransactionId, ...bet } = {
      ...input,
      externalTransactionId: reference,
      kind: 'BET',
    };
    await process.execute(bet, randomUUID());
    await new ResumePendingTransaction(unit, {
      ...runtime,
      now: () => new Date(Date.now() + 6000),
    }).execute(pending.transactionId);
    await process.execute(input, key);
    expect(await publisher().execute()).toEqual({ claimed: 7, published: 7 });
    const facts = (await receiveAll(7)).map((body) => JSON.parse(body));
    expect(
      facts.filter((event) => event.eventType === 'WagerTransactionPendingReference'),
    ).toHaveLength(1);
    expect(new Set(facts.map((event) => event.eventId)).size).toBe(7);
    await balance(wallet.id, '100.00');
  });

  test('EVT-013: stop during claim acquisition releases the unsent batch', async () => {
    const wallet = await open();
    let publishing: PublishOutbox;
    const stopping = new Proxy(store, {
      get(target, key) {
        const method = Reflect.get(target, key);
        if (typeof method !== 'function') return method;
        return async (...args: unknown[]) => {
          const result = await method.apply(target, args);
          if (key === 'claim') publishing.stop();
          return result;
        };
      },
    });
    publishing = publisher(sender, {}, stopping);
    expect(await publishing.execute()).toEqual({ claimed: 2, published: 0 });
    const rows = await events();
    expect(rows.every((row) => row.claim_token === null && row.published_at === null)).toBe(true);
    expect(await transport.receive(1, 0, 1)).toHaveLength(0);
    await balance(wallet.id, '100.00');
  });
});
