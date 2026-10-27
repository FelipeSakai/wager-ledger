import { DeleteQueueCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createHttpApplication } from '../../src/bootstrap/http-application';
import type {
  QueueDelivery,
  SqsTransport,
} from '../../src/modules/financial/application/ports/queue-transport';
import { transactionWrite } from '../../src/modules/financial/application/transactions/transaction-write-mapper';
import { DispatchDlq } from '../../src/modules/financial/application/use-cases/dispatch-dlq';
import { OpenWallet } from '../../src/modules/financial/application/use-cases/open-wallet';
import { ProcessTransaction } from '../../src/modules/financial/application/use-cases/process-transaction';
import { AwsSqsTransport } from '../../src/modules/financial/infrastructure/messaging/aws-sqs-transport';
import { MikroSqsRecoveryStore } from '../../src/modules/financial/infrastructure/messaging/mikro-sqs-recovery-store';
import { setupSqsQueues } from '../../src/modules/financial/infrastructure/messaging/setup-sqs-queues';
import { MikroFinancialUnitOfWork } from '../../src/modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { systemFinancialRuntime as runtime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';
import { HandleSqsDelivery } from '../../src/modules/financial/presentation/sqs/handle-sqs-delivery';
import { SqsConsumer } from '../../src/modules/financial/presentation/sqs/sqs-consumer';
import { SqsTransactionProducer } from '../../src/modules/financial/presentation/sqs/sqs-transaction-producer';
import { sqsClient } from '../../src/platform/messaging/sqs-client';
import { financialTestDatabase } from '../support/financial-test-database';
import { sqsRace } from '../support/sqs-race';

const client = sqsClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
  local: true,
});
let db: Awaited<ReturnType<typeof financialTestDatabase>>;
let queues: Awaited<ReturnType<typeof setupSqsQueues>>;
let transport: AwsSqsTransport;
let unit: MikroFinancialUnitOfWork;
let recovery: MikroSqsRecoveryStore;
let processor: ProcessTransaction;
let handler: HandleSqsDelivery;
let dispatcher: DispatchDlq;
const opts = {
  batchSize: 10,
  waitSeconds: 0,
  visibilitySeconds: 60,
  heartbeatMilliseconds: 20000,
  retryBaseSeconds: 1,
  retryMaxSeconds: 1,
};
async function open(amount = '100.00') {
  return new OpenWallet(unit, runtime).execute({
    playerId: randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
  });
}
function envelope(wallet: { id: string; playerId: string }, extra: Record<string, unknown> = {}) {
  return {
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...extra,
    },
  };
}
async function receive(queue = transport): Promise<QueueDelivery> {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const messages = await queue.receive(1, 0, 60);
    if (messages[0]) return messages[0];
    await runtime.sleep(10);
  }
  throw new Error('Expected queue delivery');
}
async function send(body: string, groupId: string, dedup = randomUUID()) {
  await transport.send(queues.input, body, groupId, dedup);
  return receive();
}
async function assertBalance(id: string, amount: string) {
  const [row] = await db.observer.em.fork().execute<Record<string, unknown>[]>(
    `select w.balance::text as amount,
    w.balance=coalesce(sum(case when l.direction='CREDIT' then l.amount else -l.amount end),0) as consistent
    from financial.wallets w left join financial.wallet_ledger_entries l on l.wallet_id=w.id where w.id=? group by w.id`,
    [id],
  );
  expect(row).toMatchObject({ amount, consistent: true });
}
async function counts() {
  const [row] = await db.observer.em.fork()
    .execute(`select (select count(*)::integer from financial.sqs_inbox) as inbox,
    (select count(*)::integer from financial.wallet_ledger_entries) as ledger,(select count(*)::integer from financial.outbox_messages) as events`);
  return row;
}
const wrapTransport = (overrides: Partial<SqsTransport>): SqsTransport => ({
  receive: transport.receive.bind(transport),
  send: transport.send.bind(transport),
  acknowledge: transport.acknowledge.bind(transport),
  visibility: transport.visibility.bind(transport),
  ...overrides,
});
beforeEach(async () => {
  db = await financialTestDatabase();
  const suffix = randomUUID();
  queues = await setupSqsQueues(
    client,
    `wager-test-${suffix}.fifo`,
    `wager-test-dlq-${suffix}.fifo`,
    2,
  );
  transport = new AwsSqsTransport(client, queues.input);
  unit = new MikroFinancialUnitOfWork(db.app);
  recovery = new MikroSqsRecoveryStore(db.app);
  processor = new ProcessTransaction(unit, runtime, ['provider-a', 'provider-b']);
  handler = new HandleSqsDelivery(processor, recovery, runtime, queues.input, queues.dlq);
  dispatcher = new DispatchDlq(recovery, transport, runtime);
}, 30000);
afterEach(async () => {
  if (queues) {
    await client.send(new DeleteQueueCommand({ QueueUrl: queues.input }));
    await client.send(new DeleteQueueCommand({ QueueUrl: queues.dlq }));
  }
  if (db) await db.close();
}, 30000);
afterAll(() => client.destroy());

describe('SQS inbox and recovery — PostgreSQL + LocalStack', () => {
  test('SQS-001/002: valid delivery and redelivery commit one effect and one inbox', async () => {
    const wallet = await open();
    const value = envelope(wallet);
    const body = JSON.stringify(value);
    const delivery = await send(body, wallet.id);
    expect(await handler.execute(delivery)).toEqual({ acknowledge: true, transferId: undefined });
    // Deliberately fail to ACK after commit, then expose the real message again.
    await transport.visibility(delivery.receiptHandle, 0);
    const repeated = await receive();
    expect(repeated.transportMessageId).toBe(delivery.transportMessageId);
    expect(repeated.receiptHandle).not.toBe(delivery.receiptHandle);
    expect(await handler.execute(repeated)).toMatchObject({ acknowledge: true });
    await transport.acknowledge(repeated.receiptHandle);
    expect(await counts()).toEqual({ inbox: 1, ledger: 2, events: 4 });
    await assertBalance(wallet.id, '75.00');
  });
  test('SQS-003: new envelope for an HTTP-shaped submission links replay in the same financial context', async () => {
    const wallet = await open();
    const value = envelope(wallet);
    const { idempotencyKey, ...input } = value.data;
    const original = await processor.execute(input, idempotencyKey);
    const delivery = await send(JSON.stringify(value), wallet.id);
    await handler.execute(delivery);
    expect(await recovery.decision('wager-transactions-v1', value.messageId)).toMatchObject({
      transactionId: original.transactionId,
      disposition: 'ACK_AFTER_COMMIT',
    });
    expect(await counts()).toEqual({ inbox: 1, ledger: 2, events: 4 });
    await assertBalance(wallet.id, '75.00');
  });
  test('SQS-004: conflicting inbox content preserves the original and creates a distinct diagnostic transfer', async () => {
    const wallet = await open();
    const value = envelope(wallet);
    const first = await send(JSON.stringify(value), wallet.id);
    await handler.execute(first);
    await transport.acknowledge(first.receiptHandle);
    const changed = {
      ...value,
      data: {
        ...value.data,
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        money: { amount: '1.00', currency: 'BRL' },
      },
    };
    const delivery = await send(JSON.stringify(changed), wallet.id);
    const decision = await handler.execute(delivery);
    expect(decision.acknowledge).toBe(false);
    expect(decision.transferId).toBeString();
    expect(await dispatcher.execute(decision.transferId)).toBe(true);
    const dead = await receive(new AwsSqsTransport(client, queues.dlq));
    expect(dead.body).toBe(JSON.stringify(changed));
    expect(await counts()).toEqual({ inbox: 1, ledger: 2, events: 4 });
    await assertBalance(wallet.id, '75.00');
  });
  test('SQS-006: failure after a real financial flush rolls back inbox and all new financial facts', async () => {
    const wallet = await open();
    const value = envelope(wallet);
    const failing = new ProcessTransaction(
      {
        run: (work, policy) =>
          unit.run(
            (p) =>
              work(
                new Proxy(p, {
                  get(target, key) {
                    const field = Reflect.get(target, key);
                    if (typeof field !== 'function') return field;
                    return async (...args: unknown[]) => {
                      const result = await field.apply(target, args);
                      if (key === 'recordInbox')
                        throw new Error('Injected failure after inbox insert');
                      return result;
                    };
                  },
                }),
              ),
            policy,
          ),
      },
      runtime,
      ['provider-a'],
    );
    const delivery = await send(JSON.stringify(value), wallet.id);
    await expect(
      new HandleSqsDelivery(failing, recovery, runtime, queues.input, queues.dlq).execute(delivery),
    ).rejects.toThrow();
    expect(await counts()).toEqual({ inbox: 0, ledger: 1, events: 2 });
    await assertBalance(wallet.id, '100.00');
  });
  test('SQS-007: rejection ACKs with no ledger and pending references preserve their canonical origin', async () => {
    const wallet = await open();
    const rejection = envelope(wallet, { money: { amount: '150.00', currency: 'BRL' } });
    const rejected = await send(JSON.stringify(rejection), wallet.id);
    expect(await handler.execute(rejected)).toMatchObject({ acknowledge: true });
    await transport.acknowledge(rejected.receiptHandle);
    const pending = envelope(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: randomUUID(),
    });
    const delivery = await send(JSON.stringify(pending), wallet.id);
    expect(await handler.execute(delivery)).toMatchObject({ acknowledge: true });
    const [origin] = await db.observer.em
      .fork()
      .execute(
        `select i.body,i.group_id from financial.sqs_origins o join financial.sqs_inbox i on i.id=o.inbox_id`,
      );
    expect(origin).toEqual({ body: JSON.stringify(pending), group_id: wallet.id });
    expect(await counts()).toEqual({ inbox: 2, ledger: 1, events: 4 });
    await assertBalance(wallet.id, '100.00');
  });
  test('SQS-009: invalid JSON is diagnosed durably and ACK waits for confirmed DLQ', async () => {
    const body = '{not-json';
    const group = randomUUID();
    const delivery = await send(body, group);
    const result = await handler.execute(delivery);
    expect(result.acknowledge).toBe(false);
    expect(await dispatcher.execute(result.transferId)).toBe(true);
    expect(await handler.execute(delivery)).toMatchObject({
      acknowledge: true,
      transferId: result.transferId,
    });
    expect((await receive(new AwsSqsTransport(client, queues.dlq))).body).toBe(body);
    expect(await counts()).toEqual({ inbox: 0, ledger: 0, events: 0 });
  });
  test('SQS-010/018/020: uncertain DLQ send preserves source and retries the same transfer identity', async () => {
    const body = 'invalid';
    const delivery = await send(body, randomUUID());
    const decision = await handler.execute(delivery);
    const uncertain = wrapTransport({
      send: async (...args) => {
        await transport.send(...args);
        throw new Error('Response lost after broker acceptance');
      },
    });
    const dispatch = new DispatchDlq(recovery, uncertain, runtime, {
      leaseMilliseconds: 30000,
      maxAttempts: 10,
      baseDelayMilliseconds: 1,
      maxDelayMilliseconds: 1,
    });
    expect(await dispatch.execute(decision.transferId)).toBe(false);
    expect(await recovery.confirmed(decision.transferId!)).toBe(false);
    await transport.visibility(delivery.receiptHandle, 0);
    const repeated = await receive();
    expect((await handler.execute(repeated)).transferId).toBe(decision.transferId);
    expect(await dispatcher.execute(decision.transferId)).toBe(true);
    expect((await handler.execute(repeated)).acknowledge).toBe(true);
    await transport.acknowledge(repeated.receiptHandle);
    const response = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.dlq,
        MessageAttributeNames: ['All'],
        WaitTimeSeconds: 0,
      }),
    );
    expect(response.Messages?.[0]?.Body).toBe(body);
    expect(response.Messages?.[0]?.MessageAttributes?.transferId?.StringValue).toBe(
      decision.transferId,
    );
    expect(await recovery.inspect()).toHaveLength(1);
  });
  test('SQS-023/024/029: FAILED after pending ACK creates one late task from the first origin, without redelivery', async () => {
    const wallet = await open();
    const value = envelope(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: randomUUID(),
    });
    const delivery = await send(JSON.stringify(value), wallet.id);
    await handler.execute(delivery);
    await transport.acknowledge(delivery.receiptHandle);
    const original = await recovery.decision('wager-transactions-v1', value.messageId);
    const other = { ...value, messageId: randomUUID() };
    const later = await send(JSON.stringify(other), wallet.id);
    await handler.execute(later);
    await transport.acknowledge(later.receiptHandle);
    await unit.run(async (p) => {
      await p.lockWallet(wallet.id);
      const state = (await p.findWager(original!.transactionId))!;
      await p.recordTransaction(
        {
          ...transactionWrite(state),
          status: 'FAILED',
          failureCode: 'PERMANENT_PROCESSING_FAILURE',
          completedAt: runtime.now(),
          nextReferenceAttemptAt: undefined,
          result: {
            transactionId: state.id,
            status: 'FAILED',
            failureCode: 'PERMANENT_PROCESSING_FAILURE',
            balance: wallet.balance,
            httpStatus: 500,
          },
        },
        [],
      );
    });
    const tasks = await recovery.inspect();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.reason).toBe('PENDING_REFERENCE_FAILED');
    const restarted = sqsRace(db.url, queues.input, queues.dlq, 'dispatch');
    try {
      await restarted.wait('READY');
      restarted.child.send({ type: 'START' });
      await restarted.wait('DONE');
      expect(await restarted.child.exited).toBe(0);
    } finally {
      if (restarted.child.exitCode === null) restarted.child.kill();
      await restarted.child.exited;
    }
    const dead = await receive(new AwsSqsTransport(client, queues.dlq));
    expect(dead.body).toBe(JSON.stringify(value));
    expect(await recovery.decision('wager-transactions-v1', value.messageId)).toMatchObject({
      disposition: 'DLQ_REQUIRED',
      dlqConfirmed: true,
    });
    expect(await handler.execute(delivery)).toMatchObject({ acknowledge: true });
    await assertBalance(wallet.id, '100.00');
  });
  test('SQS-019: an envelope replaying a FAILED transaction gets a durable DLQ disposition', async () => {
    const wallet = await open();
    const value = envelope(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: randomUUID(),
    });
    const { idempotencyKey, ...input } = value.data;
    const pending = await processor.execute(input, idempotencyKey);
    await unit.run(async (p) => {
      await p.lockWallet(wallet.id);
      const state = (await p.findWager(pending.transactionId))!;
      await p.recordTransaction(
        {
          ...transactionWrite(state),
          status: 'FAILED',
          failureCode: 'PERMANENT_PROCESSING_FAILURE',
          completedAt: runtime.now(),
          nextReferenceAttemptAt: undefined,
          result: {
            transactionId: state.id,
            status: 'FAILED',
            failureCode: 'PERMANENT_PROCESSING_FAILURE',
            balance: wallet.balance,
            httpStatus: 500,
          },
        },
        [],
      );
    });
    const disposition = await handler.execute(await send(JSON.stringify(value), wallet.id));
    expect(disposition.acknowledge).toBe(false);
    expect(await dispatcher.execute(disposition.transferId)).toBe(true);
    await assertBalance(wallet.id, '100.00');
  });
  test('SQS-028: fencing rejects stale confirmations; suspension is inspectable and resume is audited', async () => {
    const delivery = await send('invalid', randomUUID());
    const decision = await handler.execute(delivery);
    const claims = await Promise.all([
      recovery.claim(decision.transferId, 30000),
      new MikroSqsRecoveryStore(db.app).claim(decision.transferId, 30000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean)!;
    await db.owner.em
      .fork()
      .execute(
        "update financial.dlq_transfers set lease_until=clock_timestamp()-interval '1 second' where id=?",
        [decision.transferId],
      );
    const second = await recovery.claim(decision.transferId, 30000);
    expect(second?.claimToken).not.toBe(first?.claimToken);
    expect(await recovery.confirm(first!.id, first!.claimToken)).toBe(false);
    expect(await recovery.fail(second!.id, second!.claimToken, 1, 1)).toBe(true);
    expect((await recovery.inspect())[0]?.suspended).toBe(true);
    expect(await recovery.resume(decision.transferId!, 'local-operator')).toBe(true);
    const [audit] = await db.observer.em
      .fork()
      .execute('select operator from financial.dlq_resume_audit where transfer_id=?', [
        decision.transferId,
      ]);
    expect(audit?.operator).toBe('local-operator');
    expect(await dispatcher.execute(decision.transferId)).toBe(true);
  });
  test('consumer ACKs only after the committed handler has finished and drains on stop', async () => {
    const wallet = await open();
    const value = envelope(wallet);
    await transport.send(queues.input, JSON.stringify(value), wallet.id, value.messageId);
    let release!: () => void;
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let acknowledgements = 0;
    const consumer = new SqsConsumer(
      wrapTransport({
        acknowledge: async (handle) => {
          acknowledgements++;
          await transport.acknowledge(handle);
        },
      }),
      {
        execute: async (delivery) => {
          const result = await handler.execute(delivery);
          reached();
          await barrier;
          return result;
        },
      },
      dispatcher,
      opts,
      () => {},
    );
    const work = consumer.pollOnce();
    await ready;
    expect(acknowledgements).toBe(0);
    consumer.stop();
    release();
    await work;
    expect(acknowledgements).toBe(1);
    expect(await consumer.pollOnce()).toBe(0);
    await assertBalance(wallet.id, '75.00');
  });
  test('SQS-005/015: kill after commit before ACK, then a different process consumes the redelivery', async () => {
    const wallet = await open();
    const value = envelope(wallet);
    await transport.send(queues.input, JSON.stringify(value), wallet.id, value.messageId);
    const first = sqsRace(db.url, queues.input, queues.dlq, 'hold');
    let handle: string;
    try {
      await first.wait('READY');
      first.child.send({ type: 'START' });
      const committed = await first.wait('COMMITTED');
      handle = committed.receiptHandle!;
      await assertBalance(wallet.id, '75.00');
      first.child.kill('SIGKILL');
      await first.child.exited;
    } finally {
      if (first.child.exitCode === null) first.child.kill();
    }
    await transport.visibility(handle!, 0);
    const restarted = sqsRace(db.url, queues.input, queues.dlq);
    try {
      await restarted.wait('READY');
      restarted.child.send({ type: 'START' });
      await restarted.wait('DONE');
      expect(await restarted.child.exited).toBe(0);
    } finally {
      if (restarted.child.exitCode === null) restarted.child.kill();
    }
    expect(await counts()).toEqual({ inbox: 1, ledger: 2, events: 4 });
    await assertBalance(wallet.id, '75.00');
  });
  test('SQS-014: three worker processes advance independent groups while one wallet waits for a SQL lock', async () => {
    const wallets = await Promise.all([open(), open(), open()]);
    const inputs = wallets.map((wallet) => envelope(wallet));
    const workers = [0, 1, 2].map((index) => {
      const url = new URL(db.url);
      url.searchParams.set('application_name', `sqs-race-${index}`);
      return sqsRace(url.href, queues.input, queues.dlq);
    });
    let release!: () => void;
    let locked!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = unit.run(async (p) => {
      await p.lockWallet(wallets[0]!.id);
      locked();
      await barrier;
    });
    await ready;
    try {
      const readyWorkers = await Promise.all(workers.map((worker) => worker.wait('READY')));
      expect(new Set(readyWorkers.map((message) => message.pid)).size).toBe(3);
      await transport.send(
        queues.input,
        JSON.stringify(inputs[0]),
        wallets[0]!.id,
        inputs[0]!.messageId,
      );
      workers[0]!.child.send({ type: 'START' });
      await workers[0]!.wait('ADMITTED');
      let waiting = false;
      const deadline = performance.now() + 2000;
      while (performance.now() < deadline) {
        const [row] = await db.admin.em
          .fork()
          .execute<Record<string, unknown>[]>(
            "select exists(select 1 from pg_stat_activity where datname=? and application_name='sqs-race-0' and wait_event_type='Lock') as waiting",
            [db.name],
          );
        if (row?.waiting) {
          waiting = true;
          break;
        }
        await runtime.sleep(5);
      }
      expect(waiting).toBe(true);
      for (const index of [1, 2]) {
        await transport.send(
          queues.input,
          JSON.stringify(inputs[index]),
          wallets[index]!.id,
          inputs[index]!.messageId,
        );
        workers[index]!.child.send({ type: 'START' });
      }
      await Promise.all([workers[1]!.wait('DONE'), workers[2]!.wait('DONE')]);
      await assertBalance(wallets[1]!.id, '75.00');
      await assertBalance(wallets[2]!.id, '75.00');
      await assertBalance(wallets[0]!.id, '100.00');
      release();
      await blocker;
      await workers[0]!.wait('DONE');
      for (const worker of workers) expect(await worker.child.exited).toBe(0);
      await assertBalance(wallets[0]!.id, '75.00');
    } finally {
      release();
      await blocker;
      for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
      await Promise.all(workers.map((worker) => worker.child.exited));
    }
  });
  test('SQS-017: failed heartbeats allow two real processes to overlap on one delivery without a second debit', async () => {
    const wallet = await open();
    const value = envelope(wallet);
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const blocker = unit.run(async (persistence) => {
      await persistence.lockWallet(wallet.id);
      ready();
      await gate;
    });
    await locked;
    const workers = ['lost-visibility', 'redelivery'].map((mode, index) => {
      const url = new URL(db.url);
      url.searchParams.set('application_name', `lost-visibility-${index}`);
      return sqsRace(url.href, queues.input, queues.dlq, mode);
    });
    try {
      const started = await Promise.all(workers.map((worker) => worker.wait('READY')));
      expect(new Set(started.map((message) => message.pid)).size).toBe(2);
      await transport.send(queues.input, JSON.stringify(value), wallet.id, value.messageId);
      workers[0]!.child.send({ type: 'START' });
      const firstDelivery = await workers[0]!.wait('ADMITTED');
      await workers[0]!.wait('HEARTBEAT_FAILED');
      workers[1]!.child.send({ type: 'START' });
      const secondDelivery = await workers[1]!.wait('ADMITTED');
      expect(secondDelivery.transportMessageId).toBe(firstDelivery.transportMessageId);
      expect(secondDelivery.receiptHandle).not.toBe(firstDelivery.receiptHandle);
      let overlap = false;
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline) {
        const [row] = await db.admin.em.fork().execute<Record<string, unknown>[]>(
          `select count(*)::text as waiting from pg_stat_activity
          where datname=? and application_name in ('lost-visibility-0','lost-visibility-1') and wait_event_type='Lock'`,
          [db.name],
        );
        if (row?.waiting === '2') {
          overlap = true;
          break;
        }
        await runtime.sleep(5);
      }
      expect(overlap).toBe(true);
      await assertBalance(wallet.id, '100.00');
      release();
      await blocker;
      await Promise.all(workers.map((worker) => worker.wait('DONE')));
      for (const worker of workers) expect(await worker.child.exited).toBe(0);
      expect(await counts()).toEqual({ inbox: 1, ledger: 2, events: 4 });
      expect(await transport.receive(1, 0, 1)).toEqual([]);
      await assertBalance(wallet.id, '75.00');
    } finally {
      release();
      await blocker;
      for (const worker of workers)
        if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
      await Promise.all(workers.map((worker) => worker.child.exited));
    }
  }, 15000);
  test('SQS-012: SIGTERM drains an admitted operation before its receipt is acknowledged', async () => {
    const wallet = await open();
    const value = envelope(wallet);
    await transport.send(queues.input, JSON.stringify(value), wallet.id, value.messageId);
    let release!: () => void;
    let locked!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = unit.run(async (p) => {
      await p.lockWallet(wallet.id);
      locked();
      await barrier;
    });
    await ready;
    const worker = sqsRace(db.url, queues.input, queues.dlq);
    try {
      await worker.wait('READY');
      worker.child.send({ type: 'START' });
      await worker.wait('ADMITTED');
      worker.child.kill('SIGTERM');
      expect(worker.child.exitCode).toBeNull();
      release();
      await blocker;
      await worker.wait('DONE');
      expect(await worker.child.exited).toBe(0);
      expect(await transport.receive(1, 0, 1)).toHaveLength(0);
      await assertBalance(wallet.id, '75.00');
    } finally {
      release();
      await blocker;
      if (worker.child.exitCode === null) worker.child.kill();
      await worker.child.exited;
    }
  });

  test('SQS-001/PROC-013: concurrent real HTTP and SQS submissions share one financial result', async () => {
    const wallet = await open();
    const value = envelope(wallet);
    const delivery = await send(JSON.stringify(value), wallet.id);
    const app = await createHttpApplication({
      databaseUrl: db.url,
      cursorSecret: 'sqs-http-fixture-secret-longer-than-32',
      providers: ['provider-a'],
    });
    try {
      await app.listen(0, '127.0.0.1');
      const { idempotencyKey, ...input } = value.data;
      const [response] = await Promise.all([
        fetch(`${await app.getUrl()}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
          body: JSON.stringify(input),
        }),
        handler.execute(delivery),
      ]);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { transactionId: string };
      expect(
        (await recovery.decision('wager-transactions-v1', value.messageId))?.transactionId,
      ).toBe(body.transactionId);
      expect(await counts()).toEqual({ inbox: 1, ledger: 2, events: 4 });
      await assertBalance(wallet.id, '75.00');
    } finally {
      await app.close();
    }
  });
  test('SQS-011: real visibility renewals keep a delivery hidden past its original timeout', async () => {
    const wallet = await open();
    const value = envelope(wallet);
    await transport.send(queues.input, JSON.stringify(value), wallet.id, value.messageId);
    let release!: () => void;
    let renewed!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      renewed = resolve;
    });
    let renewals = 0;
    const consumer = new SqsConsumer(
      wrapTransport({
        visibility: async (handle, seconds) => {
          await transport.visibility(handle, seconds);
          if (++renewals >= 12) renewed();
        },
      }),
      {
        execute: async (delivery) => {
          const result = await handler.execute(delivery);
          await barrier;
          return result;
        },
      },
      dispatcher,
      { ...opts, visibilitySeconds: 1, heartbeatMilliseconds: 100 },
      () => {},
    );
    const work = consumer.pollOnce();
    try {
      await ready;
      expect(await transport.receive(1, 0, 1)).toHaveLength(0);
      expect(renewals).toBeGreaterThanOrEqual(12);
    } finally {
      release();
      await work;
      consumer.stop();
    }
    await assertBalance(wallet.id, '75.00');
  });
  test('SQS-008: real transient SQL failures are eventually redriven by the broker', async () => {
    const wallet = await open();
    const value = envelope(wallet);
    await transport.send(queues.input, JSON.stringify(value), wallet.id, value.messageId);
    let release!: () => void;
    let locked!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = unit.run(async (p) => {
      await p.lockWallet(wallet.id);
      locked();
      await barrier;
    });
    await ready;
    let handle = '';
    const consumer = new SqsConsumer(
      wrapTransport({
        visibility: async (receipt, seconds) => {
          handle = receipt;
          await transport.visibility(receipt, seconds);
        },
      }),
      handler,
      dispatcher,
      opts,
      () => {},
    );
    try {
      for (let i = 0; i < 2; i++) {
        expect(await consumer.pollOnce()).toBe(1);
        await transport.visibility(handle, 0);
      }
      expect(await consumer.pollOnce()).toBe(0);
      const dead = await receive(new AwsSqsTransport(client, queues.dlq));
      expect(dead.body).toBe(JSON.stringify(value));
    } finally {
      consumer.stop();
      release();
      await blocker;
    }
    expect(await counts()).toEqual({ inbox: 0, ledger: 1, events: 2 });
    await assertBalance(wallet.id, '100.00');
  });
  test('SQS-013: messages sharing a group run sequentially inside a received batch', async () => {
    const wallet = await open();
    const values = [
      envelope(wallet, { money: { amount: '80.00', currency: 'BRL' } }),
      envelope(wallet, { money: { amount: '80.00', currency: 'BRL' } }),
    ];
    for (const value of values)
      await transport.send(queues.input, JSON.stringify(value), wallet.id, value.messageId);
    let active = 0;
    let maximum = 0;
    let completed = 0;
    const consumer = new SqsConsumer(
      transport,
      {
        execute: async (delivery) => {
          active++;
          maximum = Math.max(maximum, active);
          try {
            return await handler.execute(delivery);
          } finally {
            active--;
            completed++;
          }
        },
      },
      dispatcher,
      opts,
      () => {},
    );
    while (completed < 2) await consumer.pollOnce();
    consumer.stop();
    expect(maximum).toBe(1);
    expect(await counts()).toEqual({ inbox: 2, ledger: 2, events: 5 });
    await assertBalance(wallet.id, '20.00');
  });
  test('SQS-016: durable inbox deduplicates a re-enqueued envelope even when the broker permits delivery', async () => {
    const wallet = await open();
    const value = envelope(wallet);
    const first = await send(JSON.stringify(value), wallet.id);
    await handler.execute(first);
    await transport.acknowledge(first.receiptHandle);
    // Different broker deduplication IDs force delivery without waiting five minutes.
    const repeated = await send(JSON.stringify(value), wallet.id);
    expect(repeated.transportMessageId).not.toBe(first.transportMessageId);
    expect(await handler.execute(repeated)).toMatchObject({ acknowledge: true });
    expect(await counts()).toEqual({ inbox: 1, ledger: 2, events: 4 });
    await assertBalance(wallet.id, '75.00');
  });
  test('SQS-021/022: producer preserves boundary IDs, while incompatible envelopes go to diagnostics', async () => {
    const wallet = await open();
    const producer = new SqsTransactionProducer(transport, queues.input);
    for (const id of ['x', 'x'.repeat(128)]) {
      const value = {
        ...envelope(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }),
        messageId: id,
      };
      await producer.send(JSON.stringify(value));
      const delivery = await receive();
      expect(await handler.execute(delivery)).toMatchObject({ acknowledge: true });
      await transport.acknowledge(delivery.receiptHandle);
    }
    const malformed = { ...envelope(wallet), messageId: 'invalid Unicode á' };
    const bad = await send(JSON.stringify(malformed), wallet.id);
    const decision = await handler.execute(bad);
    expect(decision.transferId).toBeString();
    expect(await counts()).toEqual({ inbox: 2, ledger: 1, events: 4 });
    await assertBalance(wallet.id, '100.00');
  });

  test('SQS-026/027: an HTTP pending operation captures SQS origin and failed DLQ insertion rolls back FAILED', async () => {
    const wallet = await open();
    const value = envelope(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: randomUUID(),
    });
    const { idempotencyKey, ...input } = value.data;
    const pending = await processor.execute(input, idempotencyKey);
    const delivery = await send(JSON.stringify(value), wallet.id);
    expect(await handler.execute(delivery)).toMatchObject({ acknowledge: true });
    await transport.acknowledge(delivery.receiptHandle);
    await db.owner.em.fork().execute('revoke insert on financial.dlq_transfers from wager_app');
    try {
      await expect(
        unit.run(async (p) => {
          await p.lockWallet(wallet.id);
          const state = (await p.findWager(pending.transactionId))!;
          await p.recordTransaction(
            {
              ...transactionWrite(state),
              status: 'FAILED',
              failureCode: 'PERMANENT_PROCESSING_FAILURE',
              completedAt: runtime.now(),
              nextReferenceAttemptAt: undefined,
              result: {
                transactionId: state.id,
                status: 'FAILED',
                failureCode: 'PERMANENT_PROCESSING_FAILURE',
                balance: wallet.balance,
                httpStatus: 500,
              },
            },
            [],
          );
        }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await db.owner.em.fork().execute('grant insert on financial.dlq_transfers to wager_app');
    }
    const state = await unit.run((p) => p.findWager(pending.transactionId));
    expect(state?.status).toBe('PENDING_REFERENCE');
    expect(await recovery.inspect()).toHaveLength(0);
    expect(await recovery.decision('wager-transactions-v1', value.messageId)).toMatchObject({
      disposition: 'ACK_AFTER_COMMIT',
    });
    await assertBalance(wallet.id, '100.00');
  });
  test('SQL roles protect inbox, recoverable source and transfer bodies', async () => {
    const wallet = await open();
    const value = envelope(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: randomUUID(),
    });
    await handler.execute(await send(JSON.stringify(value), wallet.id));
    for (const query of [
      "update financial.sqs_inbox set body='rewritten'",
      'delete from financial.sqs_inbox',
      'truncate financial.sqs_inbox',
      'delete from financial.sqs_origins',
      'update financial.sqs_origins set captured_at=clock_timestamp()',
    ])
      await expect(db.app.em.fork().execute(query)).rejects.toMatchObject({ code: '42501' });
    const [origin] = await db.observer.em
      .fork()
      .execute(
        'select i.body from financial.sqs_origins o join financial.sqs_inbox i on i.id=o.inbox_id',
      );
    expect(origin?.body).toBe(JSON.stringify(value));
    await assertBalance(wallet.id, '100.00');
  });

  test('a transient failure blocks later deliveries of the same received group until retry', async () => {
    const wallet = await open();
    const values = [
      envelope(wallet, { money: { amount: '80.00', currency: 'BRL' } }),
      envelope(wallet, { kind: 'WIN', money: { amount: '10.00', currency: 'BRL' } }),
    ];
    for (const value of values)
      await transport.send(queues.input, JSON.stringify(value), wallet.id, value.messageId);
    let release!: () => void;
    let locked!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = unit.run(async (p) => {
      await p.lockWallet(wallet.id);
      locked();
      await barrier;
    });
    await ready;
    let admitted = 0;
    const handles: string[] = [];
    const consumer = new SqsConsumer(
      wrapTransport({
        visibility: async (handle, seconds) => {
          handles.push(handle);
          await transport.visibility(handle, seconds);
        },
      }),
      {
        execute: (delivery) => {
          admitted++;
          return handler.execute(delivery);
        },
      },
      dispatcher,
      opts,
      () => {},
    );
    try {
      expect(await consumer.pollOnce()).toBe(2);
      expect(admitted).toBe(1);
      expect(await counts()).toEqual({ inbox: 0, ledger: 1, events: 2 });
    } finally {
      release();
      await blocker;
    }
    for (const handle of handles) await transport.visibility(handle, 0);
    await consumer.pollOnce();
    consumer.stop();
    await assertBalance(wallet.id, '30.00');
    expect(await counts()).toEqual({ inbox: 2, ledger: 3, events: 6 });
  });
});
