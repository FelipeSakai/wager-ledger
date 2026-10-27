import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { FinancialObservation } from '../../src/modules/financial/application/ports/financial-telemetry';
import { OperationalTelemetry } from '../../src/modules/financial/infrastructure/observability/operational-telemetry';
import { OperationalService } from '../../src/platform/observability/operational-service';

test('OBS-001/002/003: logs have bounded fields, valid IDs and no injected payload/secret', () => {
  const lines: string[] = [];
  const telemetry = new OperationalTelemetry('http', (line) => lines.push(line));
  const correlation = randomUUID();
  telemetry.observe({
    event: 'transaction_transition',
    correlationId: correlation,
    transactionId: randomUUID(),
    walletId: randomUUID(),
    kind: 'BET',
    status: 'PROCESSED',
    transport: 'http',
    providerId: 'injected\nsecret',
    messageId: 'invalid\nline',
    money: { amount: '999.00' },
    password: 'never-print',
    receiptHandle: 'never-print',
    cause: 'SELECT password FROM users',
    durationSeconds: Infinity,
  } as unknown as FinancialObservation);
  expect(lines).toHaveLength(1);
  const record = JSON.parse(lines[0]!);
  expect(record).toMatchObject({
    correlationId: correlation,
    service: 'wager-ledger',
    role: 'http',
    instanceId: telemetry.instanceId,
    event: 'transaction_transition',
  });
  expect(record.timestamp).toMatch(/Z$/);
  expect(lines[0]).not.toContain('never-print');
  expect(lines[0]).not.toContain('999.00');
  for (const field of [
    'providerId',
    'messageId',
    'password',
    'money',
    'receiptHandle',
    'cause',
    'durationSeconds',
  ])
    expect(record).not.toHaveProperty(field);
});
test('OBS-006: many IDs and arbitrary enum values cannot increase series without bound', () => {
  const telemetry = new OperationalTelemetry('http', () => {});
  for (let index = 0; index < 200; index++)
    telemetry.observe({
      event: 'transaction_transition',
      transactionId: randomUUID(),
      walletId: randomUUID(),
      kind: `attacker-${index}`,
      status: `attacker-${index}`,
    });
  const metrics = telemetry.render();
  expect(metrics).toContain(
    'wager_transactions_total{role="http",status="unknown",kind="unknown"} 200',
  );
  expect(metrics).not.toContain('attacker');
  expect(metrics).not.toContain('walletId');
  expect(metrics).not.toContain('transactionId');
  expect(metrics.split('\n').filter((line) => !line.startsWith('#') && line.length)).toHaveLength(
    1,
  );
});
test('histogram buckets are cumulative, monotonic and reject invalid intervals', () => {
  const telemetry = new OperationalTelemetry('sqs', () => {});
  for (const durationSeconds of [0.01, 1, -1, NaN, Infinity])
    telemetry.observe({ event: 'wallet_lock', outcome: 'success', durationSeconds });
  const metrics = telemetry.render();
  expect(metrics).toContain('# TYPE wager_lock_wait_seconds histogram');
  expect(metrics).toContain(
    'wager_lock_wait_seconds_bucket{role="sqs",outcome="success",le="0.01"} 1',
  );
  expect(metrics).toContain(
    'wager_lock_wait_seconds_bucket{role="sqs",outcome="success",le="+Inf"} 2',
  );
  expect(metrics).toContain('wager_lock_wait_seconds_count{role="sqs",outcome="success"} 2');
  expect(metrics).not.toContain('NaN');
});
test('OBS-013: a failed backlog observation preserves the last value and flags staleness', () => {
  const telemetry = new OperationalTelemetry('outbox', () => {});
  telemetry.snapshot('postgres', {
    outbox_pending: 7,
    outbox_lag_seconds: 65,
    dlq_transfer_pending: 2,
    dlq_transfer_lag_seconds: 30,
    pending_references: 1,
  });
  telemetry.snapshot('postgres', undefined);
  expect(telemetry.render()).toContain('outbox_lag_seconds{role="outbox"} 65');
  expect(telemetry.render()).toContain(
    'operational_probe_success{role="outbox",dependency="postgres"} 0',
  );
  expect(telemetry.render()).toContain('operational_probe_last_success_timestamp_seconds');
});
test('a throwing sink cannot prevent metrics or escape to the financial caller', () => {
  const telemetry = new OperationalTelemetry('http', () => {
    throw new Error('Logging failed');
  });
  expect(() =>
    telemetry.observe({ event: 'transaction_transition', kind: 'BET', status: 'PROCESSED' }),
  ).not.toThrow();
  expect(telemetry.render()).toContain(
    'wager_transactions_total{role="http",status="PROCESSED",kind="BET"} 1',
  );
});
test('OBS-007/008: initializing and stopping never report ready; independent probes have bounded parallel deadlines', async () => {
  const telemetry = new OperationalTelemetry('http', () => {});
  let active = 0;
  let maximum = 0;
  const hanging = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>(() => {});
  };
  const service = new OperationalService(
    telemetry,
    {
      postgres: hanging,
      backlog: async () => ({}),
      sqs: async () => {
        await hanging();
        return { sqs_dlq_messages: 0 };
      },
    },
    30,
    15000,
  );
  expect((await service.ready()).status).toBe('not_ready');
  service.start();
  const started = performance.now();
  const results = await Promise.all([service.ready(), service.ready()]);
  expect(performance.now() - started).toBeLessThan(300);
  expect(maximum).toBeGreaterThanOrEqual(2);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({
    status: 'not_ready',
    dependencies: {
      postgres: { status: 'down', cause: 'timeout' },
      sqs: { status: 'down', cause: 'timeout' },
    },
  });
  service.stop();
  expect((await service.ready()).status).toBe('not_ready');
  await service.close();
});
test.each([0, -1, 1.5, NaN])('probe timeout %s is refused', (timeout) => {
  expect(
    () =>
      new OperationalService(
        new OperationalTelemetry('http', () => {}),
        { postgres: async () => {}, backlog: async () => ({}) },
        timeout,
      ),
  ).toThrow(RangeError);
});
