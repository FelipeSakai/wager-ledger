import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../src/modules/financial/application/events/financial-events';

const metadata = {
  eventId: randomUUID(),
  aggregateId: randomUUID(),
  correlationId: randomUUID(),
  occurredAt: new Date('2026-10-27T18:00:00Z'),
};
const common = { transactionId: randomUUID(), walletId: metadata.aggregateId };
const money = { amount: '25.00', currency: 'BRL' };
test('EVT-011: four concrete versioned envelopes serialize money strings and protect their snapshots', () => {
  const events = [
    WagerTransactionProcessed.create(metadata, {
      ...common,
      playerId: randomUUID(),
      origin: 'PROVIDER',
      kind: 'BET',
      money,
      balance: { amount: '75.00', currency: 'BRL' },
      processedAt: metadata.occurredAt.toISOString(),
      providerId: 'provider-a',
      externalTransactionId: 'tx',
    }),
    WalletBalanceChanged.create(metadata, {
      ...common,
      direction: 'DEBIT',
      money,
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    }),
    WagerTransactionRejected.create(metadata, {
      ...common,
      origin: 'PROVIDER',
      kind: 'BET',
      failureCode: 'INSUFFICIENT_FUNDS',
      rejectedAt: metadata.occurredAt.toISOString(),
    }),
    WagerTransactionPendingReference.create(metadata, {
      ...common,
      providerId: 'provider-a',
      referenceExternalTransactionId: 'missing',
      reason: 'REFERENCE_NOT_FOUND',
      pendingAt: metadata.occurredAt.toISOString(),
    }),
  ];
  metadata.occurredAt.setTime(0);
  money.amount = '0.00';
  for (const event of events) {
    const snapshot = event.toJSON();
    expect(snapshot.version).toBe(1);
    expect(snapshot.eventType).toBe(event.eventType);
    expect(snapshot.occurredAt).toBe('2026-10-27T18:00:00.000Z');
    expect(snapshot.data.walletId).toBe(common.walletId);
    snapshot.data.walletId = randomUUID();
    expect(event.toJSON().data.walletId).toBe(common.walletId);
    expect(Object.isFrozen(event)).toBe(true);
  }
  expect(events[0]!.toJSON().data).toMatchObject({ money: { amount: '25.00', currency: 'BRL' } });
});
