import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { ForbiddenException } from '@nestjs/common';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { beginHttpShutdown, createHttpApplication } from '../../src/bootstrap/http-application';
import type { FinancialTelemetry } from '../../src/modules/financial/application/ports/financial-telemetry';
import type { FinancialUnitOfWork } from '../../src/modules/financial/application/ports/financial-unit-of-work';
import { ProviderIdentityPort } from '../../src/modules/financial/application/ports/provider-identity';
import { OpenWallet } from '../../src/modules/financial/application/use-cases/open-wallet';
import { ProcessTransaction } from '../../src/modules/financial/application/use-cases/process-transaction';
import { PublishOutbox } from '../../src/modules/financial/application/use-cases/publish-outbox';
import { ResumePendingTransaction } from '../../src/modules/financial/application/use-cases/resume-pending-transaction';
import { MikroFinancialOutboxStore } from '../../src/modules/financial/infrastructure/events/mikro-financial-outbox-store';
import { SqsEventPublication } from '../../src/modules/financial/infrastructure/events/sqs-event-publication';
import { AwsSqsTransport } from '../../src/modules/financial/infrastructure/messaging/aws-sqs-transport';
import { setupSqsQueues } from '../../src/modules/financial/infrastructure/messaging/setup-sqs-queues';
import { LocalDependencyProbes } from '../../src/modules/financial/infrastructure/observability/dependency-probes';
import { OperationalTelemetry } from '../../src/modules/financial/infrastructure/observability/operational-telemetry';
import { MikroFinancialUnitOfWork } from '../../src/modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { systemFinancialRuntime as runtime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';
import { sqsClient } from '../../src/platform/messaging/sqs-client';
import {
  closeOperationalServer,
  OperationalService,
  startOperationalServer,
} from '../../src/platform/observability/operational-service';
import { financialTestDatabase } from '../support/financial-test-database';

const client = sqsClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
  local: true,
});
let db: Awaited<ReturnType<typeof financialTestDatabase>>;
let queues: Awaited<ReturnType<typeof setupSqsQueues>>;
let names: { name: string; dlq: boolean }[];
let apps: Awaited<ReturnType<typeof createHttpApplication>>[];
let deleted: Set<string>;
const lines: Record<string, unknown>[] = [];
const telemetryFor = (role: 'http' | 'sqs' | 'outbox' | 'references') =>
  new OperationalTelemetry(role, (line) => lines.push(JSON.parse(line)));
const sql = (query: string, params: unknown[] = []) =>
  db.observer.em.fork().execute<Record<string, unknown>[]>(query, params);
const command = (
  wallet: { id: string; playerId: string },
  kind = 'BET',
  extra: Record<string, unknown> = {},
) => ({
  providerId: 'provider-a',
  externalTransactionId: randomUUID(),
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId: 'round',
  gameId: 'game',
  kind,
  money: { amount: '25.00', currency: 'BRL' },
  ...extra,
});
async function appWith(extra: Partial<Parameters<typeof createHttpApplication>[0]> = {}) {
  const app = await createHttpApplication({
    databaseUrl: db.url,
    cursorSecret: 'observability-secret-at-least-32-bytes',
    providers: ['provider-a'],
    queues: names,
    telemetry: telemetryFor('http'),
    ...extra,
  });
  apps.push(app);
  await app.listen(0, '127.0.0.1');
  return { app, base: await app.getUrl() };
}
async function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
async function open(unit = new MikroFinancialUnitOfWork(db.app)) {
  return new OpenWallet(unit, runtime).execute({
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
}
async function balance(id: string, amount: string) {
  const [row] = await sql(
    `select w.balance::text as amount,w.balance=coalesce(sum(case when l.direction='CREDIT' then l.amount else -l.amount end),0) as consistent
    from financial.wallets w left join financial.wallet_ledger_entries l on l.wallet_id=w.id where w.id=? group by w.id`,
    [id],
  );
  expect(row).toEqual({ amount, consistent: true });
}
beforeEach(async () => {
  apps = [];
  lines.length = 0;
  deleted = new Set();
  db = await financialTestDatabase();
  const id = randomUUID();
  names = [
    { name: `observability-test-${id}.fifo`, dlq: false },
    { name: `observability-test-dlq-${id}.fifo`, dlq: true },
  ];
  queues = await setupSqsQueues(client, names[0]!.name, names[1]!.name);
}, 30000);
afterEach(async () => {
  for (const app of apps) await app.close();
  if (queues)
    for (const queue of [queues.input, queues.dlq])
      if (!deleted.has(queue)) await client.send(new DeleteQueueCommand({ QueueUrl: queue }));
  if (db) await db.close();
}, 30000);
afterAll(() => client.destroy());

test('OBS-007/009: public live/ready endpoints read real PostgreSQL/SQS without creating financial facts', async () => {
  class DenyAll extends ProviderIdentityPort {
    async authorize(): Promise<void> {
      throw new ForbiddenException();
    }
  }
  const { base } = await appWith({ identity: new DenyAll() });
  const live = await fetch(base + '/health/live');
  expect(live.status).toBe(200);
  expect(await live.json()).toEqual({ status: 'alive' });
  const ready = await fetch(base + '/health/ready');
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({
    status: 'ready',
    dependencies: { postgres: { status: 'up' }, sqs: { status: 'up' } },
  });
  expect(await sql('select id from financial.wallets')).toEqual([]);
  expect(await sql('select id from financial.outbox_messages')).toEqual([]);
  const metrics = await fetch(base + '/metrics');
  expect(metrics.headers.get('content-type')).toContain('text/plain');
  expect(metrics.status).toBe(200);
});
test('deleting a required real queue makes ready fail safely while live still responds', async () => {
  const { base } = await appWith();
  expect((await fetch(base + '/health/ready')).status).toBe(200);
  await client.send(new DeleteQueueCommand({ QueueUrl: queues.dlq }));
  deleted.add(queues.dlq);
  const response = await fetch(base + '/health/ready');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    dependencies: { postgres: { status: 'up' }, sqs: { status: 'down' } },
  });
  expect((await fetch(base + '/health/live')).status).toBe(200);
  const metrics = await (await fetch(base + '/metrics')).text();
  expect(metrics).toContain(
    'dependency_probe_failures_total{role="http",dependency="sqs",cause="unavailable"}',
  );
  expect(JSON.stringify(lines)).not.toContain('http://');
  expect(JSON.stringify(lines)).not.toContain('QueueDoesNotExist');
});
test('an unreachable SQS endpoint fails readiness with bounded latency and no error details', async () => {
  const { base } = await appWith({
    sqsEndpoint: 'http://127.0.0.1:1',
    probeTimeoutMilliseconds: 250,
  });
  const start = performance.now();
  const response = await fetch(base + '/health/ready');
  expect(response.status).toBe(503);
  expect(performance.now() - start).toBeLessThan(1500);
  const body = await response.text();
  expect(body).not.toContain('127.0.0.1');
  expect(body).not.toContain('ECONNREFUSED');
  expect((await fetch(base + '/health/live')).status).toBe(200);
});
test('PostgreSQL unavailable in the isolated test database does not break liveness', async () => {
  const { base } = await appWith({ probeTimeoutMilliseconds: 500 });
  expect((await fetch(base + '/health/ready')).status).toBe(200);
  await db.admin.em.fork().execute(`alter database "${db.name}" allow_connections false`);
  try {
    await db.admin.em
      .fork()
      .execute(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname=? and usename='wager_app'`,
        [db.name],
      );
    const response = await fetch(base + '/health/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ dependencies: { postgres: { status: 'down' } } });
    expect((await fetch(base + '/health/live')).status).toBe(200);
  } finally {
    await db.admin.em.fork().execute(`alter database "${db.name}" allow_connections true`);
  }
});
test('OBS-008: draining readiness is 503 and refuses new financial admissions', async () => {
  const { app, base } = await appWith();
  beginHttpShutdown(app);
  expect((await fetch(base + '/health/ready')).status).toBe(503);
  expect((await fetch(base + '/health/live')).status).toBe(200);
  const result = await post(base, '/wallets', {
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  expect(result.status).toBe(503);
  expect(result.body).toMatchObject({ error: { code: 'SERVICE_STOPPING' } });
  expect(await sql('select id from financial.wallets')).toEqual([]);
});
test('OBS-001/004/006: concurrent requests retain correlation; replay is separate and rejection never counts as a debit', async () => {
  const telemetry = telemetryFor('http');
  const { base } = await appWith({ telemetry });
  const wallets = [await open(), await open()];
  const inputs = wallets.map((wallet) => command(wallet));
  const correlations = [randomUUID(), randomUUID()];
  const keys = [randomUUID(), randomUUID()];
  const results = await Promise.all(
    inputs.map((input, index) =>
      post(base, '/wagering/transactions', input, {
        'Idempotency-Key': keys[index]!,
        'X-Correlation-Id': correlations[index]!,
      }),
    ),
  );
  expect(results.map((result) => result.status)).toEqual([200, 200]);
  await post(base, '/wagering/transactions', inputs[0], { 'Idempotency-Key': keys[0]! });
  await post(
    base,
    '/wagering/transactions',
    command(wallets[0]!, 'BET', { money: { amount: '150.00', currency: 'BRL' } }),
    { 'Idempotency-Key': randomUUID() },
  );
  for (let index = 0; index < 2; index++)
    expect(
      lines.find(
        (line) =>
          line.event === 'transaction_transition' &&
          line.transactionId === results[index]!.body.transactionId,
      ),
    ).toMatchObject({
      correlationId: correlations[index],
      walletId: wallets[index]!.id,
      providerId: 'provider-a',
    });
  const metrics = await (await fetch(base + '/metrics')).text();
  expect(metrics).toContain(
    'wager_transactions_total{role="http",status="PROCESSED",kind="BET"} 2',
  );
  expect(metrics).toContain('wager_transactions_total{role="http",status="REJECTED",kind="BET"} 1');
  expect(metrics).toContain('wager_duplicates_total{role="http",layer="business"} 1');
  for (const wallet of wallets) {
    expect(metrics).not.toContain(wallet.id);
    await balance(wallet.id, '75.00');
  }
});
test('a real SQL rollback does not emit a committed transaction counter', async () => {
  const telemetry = telemetryFor('http');
  const unit = new MikroFinancialUnitOfWork(db.app, telemetry);
  const wallet = await open();
  const failing: FinancialUnitOfWork = {
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
                  if (property === 'appendMovement') throw new Error('After flush');
                  return result;
                };
              },
            }),
          ),
        options,
      ),
  };
  await expect(
    new ProcessTransaction(failing, runtime, ['provider-a'], {}, telemetry).execute(
      command(wallet),
      randomUUID(),
    ),
  ).rejects.toBeDefined();
  expect(telemetry.render()).not.toContain('wager_transactions_total');
  await balance(wallet.id, '100.00');
});
test('OBS-004: a real wallet lock timeout measures conflict/retry and only one committed movement', async () => {
  const telemetry = telemetryFor('http');
  const unit = new MikroFinancialUnitOfWork(db.app, telemetry);
  const wallet = await open();
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const blocker = unit.run(async (p) => {
    await p.lockWallet(wallet.id);
    ready();
    await gate;
  });
  await locked;
  const observed: FinancialTelemetry = {
    observe: (event) => {
      telemetry.observe(event);
      if (event.event === 'financial_retry') release();
    },
  };
  try {
    const correlation = randomUUID();
    const result = await new ProcessTransaction(
      unit,
      runtime,
      ['provider-a'],
      { lockTimeoutMilliseconds: 20 },
      observed,
    ).execute(command(wallet), randomUUID(), correlation);
    expect(result.status).toBe('PROCESSED');
    const technical = lines.filter(
      (line) =>
        ['financial_retry', 'lock_conflict', 'wallet_lock'].includes(String(line.event)) &&
        line.correlationId === correlation,
    );
    expect(new Set(technical.map((line) => line.event))).toEqual(
      new Set(['financial_retry', 'lock_conflict', 'wallet_lock']),
    );
    for (const line of technical)
      expect(line).toMatchObject({
        correlationId: correlation,
        walletId: wallet.id,
        providerId: 'provider-a',
      });
    expect(telemetry.render()).toContain(
      'wager_lock_conflicts_total{role="http",cause="transient"} 1',
    );
    expect(telemetry.render()).toContain(
      'wager_retries_total{role="http",component="financial",cause="TRANSIENT"} 1',
    );
    await balance(wallet.id, '75.00');
  } finally {
    release();
    await blocker;
  }
});
test('a throwing telemetry port cannot alter a successful commit', async () => {
  const broken: FinancialTelemetry = {
    observe: () => {
      throw new Error('Sink failed');
    },
  };
  const unit = new MikroFinancialUnitOfWork(db.app, broken);
  const wallet = await new OpenWallet(unit, runtime, {}, broken).execute({
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  expect(
    (
      await new ProcessTransaction(unit, runtime, ['provider-a'], {}, broken).execute(
        command(wallet),
        randomUUID(),
      )
    ).status,
  ).toBe('PROCESSED');
  await balance(wallet.id, '75.00');
});
test('OBS-005/014: suspended outbox and DLQ obligations contribute backlog/lag; failed SQL sampling preserves observations', async () => {
  const wallet = await open();
  const recoveryTelemetry = telemetryFor('sqs');
  const { MikroSqsRecoveryStore } =
    await import('../../src/modules/financial/infrastructure/messaging/mikro-sqs-recovery-store');
  const store = new MikroSqsRecoveryStore(db.app);
  await store.diagnose({
    id: randomUUID(),
    diagnosticKey: 'a'.repeat(64),
    consumerName: 'test',
    bodyHash: 'b'.repeat(64),
    body: 'original-secret',
    sourceQueue: queues.input,
    transportMessageId: randomUUID(),
    groupId: wallet.id,
    destination: queues.dlq,
    reason: 'INVALID_SQS_ENVELOPE',
  });
  await db.owner.em
    .fork()
    .execute(
      'update financial.outbox_messages set suspended_at=clock_timestamp(),occurred_at=occurred_at where published_at is null',
    );
  const probes = new LocalDependencyProbes(db.app, client, names);
  const service = new OperationalService(recoveryTelemetry, probes, 2000, 15000);
  await service.sample();
  expect(recoveryTelemetry.render()).toContain('outbox_pending{role="sqs"} 2');
  expect(recoveryTelemetry.render()).toContain('dlq_transfer_pending{role="sqs"} 1');
  expect(recoveryTelemetry.render()).toContain('outbox_lag_seconds');
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const lock = db.owner.em.fork().transactional(async (em) => {
    await em.execute('lock table financial.outbox_messages in access exclusive mode');
    ready();
    await gate;
  });
  await locked;
  try {
    await service.sample();
    expect(recoveryTelemetry.render()).toContain(
      'operational_probe_success{role="sqs",dependency="postgres"} 0',
    );
    expect(recoveryTelemetry.render()).toContain('outbox_pending{role="sqs"} 2');
  } finally {
    release();
    await lock;
    await service.close();
  }
  expect(JSON.stringify(lines)).not.toContain('original-secret');
  await balance(wallet.id, '100.00');
});
test('OBS-001: accepted correlation reaches a real SQS publication log', async () => {
  const telemetry = telemetryFor('http');
  const unit = new MikroFinancialUnitOfWork(db.app, telemetry);
  const wallet = await open();
  const correlation = randomUUID();
  const result = await new ProcessTransaction(unit, runtime, ['provider-a'], {}, telemetry).execute(
    command(wallet),
    randomUUID(),
    correlation,
  );
  const publisherTelemetry = telemetryFor('outbox');
  const publisher = new PublishOutbox(
    new MikroFinancialOutboxStore(db.app),
    new SqsEventPublication(new AwsSqsTransport(client, queues.input), queues.input),
    runtime,
    {},
    () => {
      throw new Error('Logger unavailable after confirmation');
    },
    publisherTelemetry,
  );
  expect((await publisher.execute()).published).toBe(4);
  expect(
    lines.find(
      (line) =>
        line.role === 'outbox' &&
        line.event === 'outbox_published' &&
        line.transactionId === result.transactionId,
    ),
  ).toMatchObject({ correlationId: correlation, walletId: wallet.id });
  expect(publisherTelemetry.render()).toContain(
    'outbox_publish_attempts_total{role="outbox",outcome="success"} 4',
  );
  await balance(wallet.id, '75.00');
});
test('reference completion preserves the original accepted correlation in its new outbox events', async () => {
  let now = Date.now();
  const clock = { ...runtime, now: () => new Date(now), random: () => 0 };
  const telemetry = telemetryFor('references');
  const unit = new MikroFinancialUnitOfWork(db.app, telemetry);
  const wallet = await open();
  const bet = command(wallet);
  const correlation = randomUUID();
  const processor = new ProcessTransaction(unit, clock, ['provider-a'], {}, telemetry);
  const pending = await processor.execute(
    command(wallet, 'REFUND', { referenceExternalTransactionId: bet.externalTransactionId }),
    randomUUID(),
    correlation,
  );
  await processor.execute(bet, randomUUID());
  now += 3000;
  await new ResumePendingTransaction(unit, clock, {}, telemetry).execute(pending.transactionId);
  const events = await sql(
    `select payload->>'correlationId' as correlation from financial.outbox_messages where transaction_id=?`,
    [pending.transactionId],
  );
  expect(events).toHaveLength(3);
  expect(events.every((event) => event.correlation === correlation)).toBe(true);
  await balance(wallet.id, '100.00');
});
test('workers have an independent loopback operations server with per-role metrics', async () => {
  const telemetry = telemetryFor('references');
  const service = new OperationalService(telemetry, new LocalDependencyProbes(db.app));
  const server = await startOperationalServer(service, 0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    expect((await fetch(base + '/health/ready')).status).toBe(503);
    service.start();
    expect((await fetch(base + '/health/ready')).status).toBe(200);
    const metrics = await (await fetch(base + '/metrics')).text();
    expect(metrics).toContain('role="references"');
    service.stop();
    expect((await fetch(base + '/health/ready')).status).toBe(503);
  } finally {
    await closeOperationalServer(server);
    await service.close();
  }
});

test('SQS inbox replay, DLQ dispatch and approximate DLQ gauges are observable without logging bodies', async () => {
  const { MikroSqsRecoveryStore } =
    await import('../../src/modules/financial/infrastructure/messaging/mikro-sqs-recovery-store');
  const { HandleSqsDelivery } =
    await import('../../src/modules/financial/presentation/sqs/handle-sqs-delivery');
  const { DispatchDlq } =
    await import('../../src/modules/financial/application/use-cases/dispatch-dlq');
  const telemetry = telemetryFor('sqs');
  const unit = new MikroFinancialUnitOfWork(db.app, telemetry);
  const wallet = await open();
  const recovery = new MikroSqsRecoveryStore(db.app);
  const transport = new AwsSqsTransport(client, queues.input);
  const handler = new HandleSqsDelivery(
    new ProcessTransaction(unit, runtime, ['provider-a'], {}, telemetry),
    recovery,
    runtime,
    queues.input,
    queues.dlq,
    'wager-transactions-v1',
    telemetry,
  );
  const envelope = {
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...command(wallet), idempotencyKey: randomUUID(), gameId: 'do-not-log-this-secret' },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await transport.send(queues.input, JSON.stringify(envelope), wallet.id, randomUUID());
    const [delivery] = await transport.receive(1, 0, 60);
    if (!delivery) throw new Error('Expected owned delivery');
    expect((await handler.execute(delivery)).acknowledge).toBe(true);
    await transport.acknowledge(delivery.receiptHandle);
  }
  const transition = lines.find(
    (line) => line.event === 'transaction_transition' && line.role === 'sqs',
  );
  expect(transition).toMatchObject({
    messageId: envelope.messageId,
    providerId: 'provider-a',
    walletId: wallet.id,
  });
  expect(telemetry.render()).toContain('wager_duplicates_total{role="sqs",layer="inbox"} 1');
  expect(telemetry.render()).toContain('wager_duplicates_total{role="sqs",layer="business"} 1');
  await transport.send(queues.input, 'invalid-body-do-not-log', wallet.id, randomUUID());
  const [invalid] = await transport.receive(1, 0, 60);
  if (!invalid) throw new Error('Expected invalid delivery');
  const disposition = await handler.execute(invalid);
  expect(disposition.acknowledge).toBe(false);
  expect(disposition.transferId).toBeDefined();
  expect(
    await new DispatchDlq(recovery, transport, runtime, undefined, telemetry).execute(
      disposition.transferId,
    ),
  ).toBe(true);
  await transport.acknowledge(invalid.receiptHandle);
  const service = new OperationalService(
    telemetry,
    new LocalDependencyProbes(db.app, client, names),
  );
  try {
    await service.sample();
    expect(telemetry.render()).toContain('sqs_dlq_messages{role="sqs"} 1');
    expect(telemetry.render()).toContain('dlq_transfers_total{role="sqs",outcome="confirmed"} 1');
  } finally {
    await service.close();
  }
  expect(JSON.stringify(lines)).not.toContain('do-not-log');
  await balance(wallet.id, '75.00');
});
test('OBS-008: SIGTERM of the real HTTP process drains a transaction admitted before shutdown', async () => {
  const { createServer } = await import('node:net');
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing reserved port');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const url = new URL(db.url);
  url.searchParams.set('application_name', 'observability-http-shutdown');
  const child = Bun.spawn([process.execPath, Bun.resolveSync('../../src/main.ts', __dirname)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: url.href,
      PORT: String(port),
      HTTP_HOST: '127.0.0.1',
      LEDGER_CURSOR_SECRET: 'process-test-secret-more-than-thirty-two-bytes',
      FINANCIAL_PROVIDERS: 'provider-a',
      SQS_QUEUE_NAME: names[0]!.name,
      SQS_DLQ_NAME: names[1]!.name,
      SQS_EVENTS_QUEUE_NAME: names[0]!.name,
      SQS_EVENTS_DLQ_NAME: names[1]!.name,
      HTTP_SHUTDOWN_MILLISECONDS: '5000',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15000,
  });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  const unit = new MikroFinancialUnitOfWork(db.app);
  const wallet = await open();
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let blocker: Promise<unknown> | undefined;
  try {
    const deadline = performance.now() + 5000;
    let live = false;
    while (performance.now() < deadline) {
      try {
        live = (await fetch(base + '/health/live')).status === 200;
        if (live) break;
      } catch {}
      await runtime.sleep(10);
    }
    expect(live).toBe(true);
    expect((await fetch(base + '/health/ready')).status).toBe(200);
    blocker = unit.run(async (p) => {
      await p.lockWallet(wallet.id);
      ready();
      await gate;
    });
    await locked;
    const request = post(base, '/wagering/transactions', command(wallet), {
      'Idempotency-Key': randomUUID(),
    });
    let waiting = 0;
    const lockDeadline = performance.now() + 2000;
    while (performance.now() < lockDeadline) {
      const [row] = await db.admin.em.fork().execute<{ waiting: number }[]>(
        `select count(*)::integer as waiting from pg_stat_activity
        where datname=? and application_name='observability-http-shutdown' and wait_event_type='Lock'`,
        [db.name],
      );
      waiting = row!.waiting;
      if (waiting) break;
      await runtime.sleep(5);
    }
    expect(waiting).toBe(1);
    child.kill('SIGTERM');
    release();
    await blocker;
    expect((await request).status).toBe(200);
    expect(await child.exited).toBe(0);
    const records = (await output)
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.some((record) => record.event === 'service_stopping')).toBe(true);
    expect(
      records.some((record) => record.event === 'transaction_transition' && record.kind === 'BET'),
    ).toBe(true);
    expect(await errors).not.toContain('password');
    await balance(wallet.id, '75.00');
  } finally {
    release?.();
    await blocker;
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    await output;
    await errors;
  }
}, 15000);

test('OBS-001: separate SQS deliveries correlate locks, transitions and ACKs without sharing context', async () => {
  const telemetry = telemetryFor('sqs');
  const unit = new MikroFinancialUnitOfWork(db.app, telemetry);
  const transport = new AwsSqsTransport(client, queues.input);
  const { HandleSqsDelivery } =
    await import('../../src/modules/financial/presentation/sqs/handle-sqs-delivery');
  const { SqsConsumer } = await import('../../src/modules/financial/presentation/sqs/sqs-consumer');
  const { MikroSqsRecoveryStore } =
    await import('../../src/modules/financial/infrastructure/messaging/mikro-sqs-recovery-store');
  const { DispatchDlq } =
    await import('../../src/modules/financial/application/use-cases/dispatch-dlq');
  const recovery = new MikroSqsRecoveryStore(db.app);
  const wallets = await Promise.all([open(), open()]);
  const messageIds = wallets.map(() => randomUUID());
  for (const [index, wallet] of wallets.entries()) {
    await transport.send(
      queues.input,
      JSON.stringify({
        messageId: messageIds[index],
        type: 'WagerTransactionRequested',
        occurredAt: runtime.now().toISOString(),
        data: { ...command(wallet), idempotencyKey: randomUUID() },
      }),
      wallet.id,
      messageIds[index]!,
    );
  }
  // Collect two actual broker deliveries, then admit them as one controlled batch.
  const deliveries: Awaited<ReturnType<typeof transport.receive>> = [];
  const receiveDeadline = performance.now() + 4000;
  while (deliveries.length < 2 && performance.now() < receiveDeadline) {
    deliveries.push(...(await transport.receive(2 - deliveries.length, 1, 60)));
  }
  expect(deliveries).toHaveLength(2);
  const batch = {
    receive: async () => deliveries,
    send: transport.send.bind(transport),
    acknowledge: transport.acknowledge.bind(transport),
    visibility: transport.visibility.bind(transport),
  };
  const handler = new HandleSqsDelivery(
    new ProcessTransaction(unit, runtime, ['provider-a'], {}, telemetry),
    recovery,
    runtime,
    queues.input,
    queues.dlq,
    'wager-transactions-v1',
    telemetry,
  );
  const consumer = new SqsConsumer(
    batch,
    handler,
    new DispatchDlq(recovery, transport, runtime),
    undefined,
    (event, context) => telemetry.observe({ event, ...context, outcome: 'failure' }),
    telemetry,
  );
  try {
    await consumer.pollOnce();
  } finally {
    consumer.stop();
  }
  const correlations = new Set<string>();
  for (const [index, wallet] of wallets.entries()) {
    const committed = lines.find(
      (line) => line.event === 'transaction_transition' && line.walletId === wallet.id,
    );
    expect(committed).toMatchObject({
      messageId: messageIds[index],
      providerId: 'provider-a',
      status: 'PROCESSED',
    });
    const context = {
      correlationId: committed!.correlationId,
      transactionId: committed!.transactionId,
      messageId: messageIds[index],
      walletId: wallet.id,
      providerId: 'provider-a',
    };
    expect(
      lines.some(
        (line) =>
          line.event === 'wallet_lock' &&
          line.correlationId === context.correlationId &&
          line.messageId === context.messageId,
      ),
    ).toBe(true);
    expect(
      lines.find(
        (line) =>
          line.event === 'sqs_delivery' &&
          line.outcome === 'acknowledged' &&
          line.walletId === wallet.id,
      ),
    ).toMatchObject(context);
    correlations.add(String(committed!.correlationId));
    await balance(wallet.id, '75.00');
  }
  expect(correlations.size).toBe(2);
  expect(await transport.receive(1, 0, 1)).toEqual([]);
});
