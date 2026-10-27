import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SqsTransactionProducer } from '../../src/modules/financial/presentation/sqs/sqs-transaction-producer';
import {
  canonicalJson,
  transactionEnvelope,
} from '../../src/modules/financial/presentation/sqs/transaction-envelope';
const envelope = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-10-27T20:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'external-123',
    idempotencyKey: 'key-123',
    walletId: '00000000-0000-4000-8000-000000000001',
    playerId: '00000000-0000-4000-8000-000000000002',
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};
test.each(['x', 'x'.repeat(128), randomUUID()])(
  'SQS-021: accepted ID %s is preserved by the producer',
  async (id) => {
    const calls: unknown[][] = [];
    const producer = new SqsTransactionProducer(
      {
        send: async (...args: unknown[]) => {
          calls.push(args);
        },
      } as never,
      'input.fifo',
    );
    const body = JSON.stringify({ ...envelope, messageId: id });
    await producer.send(body);
    expect(calls).toEqual([['input.fifo', body, envelope.data.walletId, id]]);
  },
);
test.each(['', 'x'.repeat(129), ' with-space', 'with-space ', 'a b', 'á', '日本', 'a/b', 'a.b'])(
  'SQS-022: invalid message ID is rejected before transport',
  async (id) => {
    let sent = false;
    const producer = new SqsTransactionProducer(
      {
        send: async () => {
          sent = true;
        },
      } as never,
      'input',
    );
    await expect(
      producer.send(JSON.stringify({ ...envelope, messageId: id })),
    ).rejects.toMatchObject({ code: 'INVALID_SQS_ENVELOPE' });
    expect(sent).toBe(false);
  },
);
test.each([
  '2026-02-30T20:00:00Z',
  '2026-10-27',
  '2026-10-27T25:00:00Z',
  'invalid',
  '2026-10-27T20:00:00+99:00',
])('reject invalid occurredAt %s', (date) => {
  expect(() => transactionEnvelope(JSON.stringify({ ...envelope, occurredAt: date }))).toThrow(
    expect.objectContaining({ code: 'INVALID_SQS_ENVELOPE' }),
  );
});
test('accept valid ISO offset and preserve it in the canonical envelope hash input', () => {
  const value = { ...envelope, occurredAt: '2026-10-27T17:00:00-03:00' };
  expect(transactionEnvelope(JSON.stringify(value)).canonical).toContain('17:00:00-03:00');
});
test('envelope canonicalization includes identity, time and the business key, independently of object key order', () => {
  const normal = transactionEnvelope(JSON.stringify(envelope));
  const reordered = Object.fromEntries(Object.entries(envelope).reverse());
  expect(transactionEnvelope(JSON.stringify(reordered)).canonical).toBe(normal.canonical);
  expect(canonicalJson({ b: 2, a: { z: 'value', a: 'first' } })).toBe(
    '{"a":{"a":"first","z":"value"},"b":2}',
  );
  for (const change of [
    { messageId: 'other' },
    { occurredAt: '2026-10-28T20:00:00.000Z' },
    { data: { ...envelope.data, idempotencyKey: 'other' } },
  ]) {
    expect(transactionEnvelope(JSON.stringify({ ...envelope, ...change })).canonical).not.toBe(
      normal.canonical,
    );
  }
});
test('unknown envelope fields and malformed business data cannot create an inbox', () => {
  for (const extra of [
    { type: 'Other' },
    { origin: 'INTERNAL' },
    { data: { ...envelope.data, origin: 'INTERNAL' } },
    { data: { ...envelope.data, money: { amount: 25, currency: 'BRL' } } },
    { data: { ...envelope.data, idempotencyKey: undefined } },
  ]) {
    expect(() => transactionEnvelope(JSON.stringify({ ...envelope, ...extra }))).toThrow();
  }
});
