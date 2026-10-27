import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { serializeOutboxEnvelope } from '../../src/modules/financial/application/events/outbox-envelope';
import type { OutboxClaim } from '../../src/modules/financial/application/ports/financial-outbox-store';
import { PublishOutbox } from '../../src/modules/financial/application/use-cases/publish-outbox';
import { systemFinancialRuntime as runtime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';

const id = randomUUID();
const walletId = randomUUID();
const transactionId = randomUUID();
const correlationId = randomUUID();
const payload = {
  eventId: id,
  eventType: 'WalletBalanceChanged',
  version: 1,
  aggregateId: walletId,
  correlationId,
  occurredAt: '2026-10-27T20:00:00.000Z',
  data: {
    transactionId,
    walletId,
    direction: 'DEBIT',
    walletVersion: 2,
    money: { amount: '25.00', currency: 'BRL' },
    balanceBefore: { amount: '100.00', currency: 'BRL' },
    balanceAfter: { amount: '75.00', currency: 'BRL' },
  },
};
const claim: OutboxClaim = {
  id,
  transactionId,
  aggregateId: walletId,
  eventType: 'WalletBalanceChanged',
  eventVersion: 1,
  payload,
  occurredAt: payload.occurredAt,
  claimToken: randomUUID(),
  attempts: 0,
};
test('publication serializes the stored envelope without inserting claim or transport metadata', () => {
  expect(serializeOutboxEnvelope(claim)).toBe(JSON.stringify(payload));
  expect(serializeOutboxEnvelope({ ...claim, attempts: 7, claimToken: randomUUID() })).toBe(
    JSON.stringify(payload),
  );
});
test.each([
  { eventId: randomUUID() },
  { aggregateId: randomUUID() },
  { version: 2 },
  { correlationId: 'invalid' },
  { occurredAt: '2026-02-30T00:00:00Z' },
  { data: { ...payload.data, money: { amount: 25, currency: 'BRL' } } },
  { data: { ...payload.data, balanceAfter: { amount: '75.0', currency: 'BRL' } } },
  { data: { ...payload.data, walletVersion: 0 } },
  { data: { ...payload.data, direction: 'OTHER' } },
  { eventType: 'Unknown' },
])('invalid persisted envelope is rejected before network I/O', (patch) => {
  expect(() => serializeOutboxEnvelope({ ...claim, payload: { ...payload, ...patch } })).toThrow(
    'Persisted event envelope is invalid',
  );
});
test('malformed stored timestamp and currency are diagnosed without exposing raw data', () => {
  expect(() => serializeOutboxEnvelope({ ...claim, occurredAt: 'broken' })).toThrow(
    'Persisted event envelope is invalid',
  );
  expect(() =>
    serializeOutboxEnvelope({
      ...claim,
      payload: {
        ...payload,
        data: { ...payload.data, money: { amount: '25.00', currency: 'USD' } },
      },
    }),
  ).toThrow();
});
test.each([
  { batchSize: 0 },
  { batchSize: 11 },
  { leaseMilliseconds: 0 },
  { heartbeatMilliseconds: 30000 },
  { maxAttempts: 0 },
  { baseDelayMilliseconds: 0 },
  { maxDelayMilliseconds: 1 },
])('operational limits are validated at construction', (policy) => {
  expect(() => new PublishOutbox({} as never, {} as never, runtime, policy)).toThrow(
    'Invalid outbox publisher policy',
  );
});
test('stop prevents any new claim', async () => {
  let claims = 0;
  const store = {
    claim: async () => {
      claims++;
      return [];
    },
  };
  const publisher = new PublishOutbox(store as never, {} as never, runtime);
  publisher.stop();
  expect(await publisher.execute()).toEqual({ claimed: 0, published: 0 });
  expect(claims).toBe(0);
});
