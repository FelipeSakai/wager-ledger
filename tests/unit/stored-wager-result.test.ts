import { expect, test } from 'bun:test';
import { storedWagerResult } from '../../src/modules/financial/infrastructure/persistence/stored-wager-result';

const statuses = [
  ['PROCESSED', 200],
  ['PENDING_REFERENCE', 202],
  ['REJECTED', 422],
  ['FAILED', 500],
] as const;
test.each(statuses)(
  'legacy %s result keeps its financial snapshot without transport metadata',
  (status, httpStatus) => {
    const result = {
      transactionId: 'transaction',
      status,
      balance: { amount: '75.00', currency: 'BRL' },
      ...(['REJECTED', 'FAILED'].includes(status) ? { failureCode: 'EXAMPLE' } : {}),
    };
    const stored = { ...result, httpStatus };
    const before = structuredClone(stored);
    const decoded = storedWagerResult(stored);
    expect(decoded).toEqual(result);
    expect(decoded).not.toHaveProperty('httpStatus');
    expect(stored).toEqual(before);
    decoded!.balance.amount = '0.00';
    expect(stored.balance.amount).toBe('75.00');
  },
);
test.each(statuses)(
  'legacy %s with a mismatched HTTP status remains a storage integrity error',
  (status, httpStatus) => {
    expect(() => storedWagerResult({ status, httpStatus: httpStatus === 200 ? 422 : 200 })).toThrow(
      expect.objectContaining({ code: 'INVALID_PERSISTED_TRANSACTION' }),
    );
  },
);
test('new storage results need no transport field', () => {
  const result = {
    transactionId: 'transaction',
    status: 'PROCESSED' as const,
    balance: { amount: '75.00', currency: 'BRL' },
  };
  expect(storedWagerResult(result)).toEqual(result);
});
test('null remains absent while malformed legacy results are not silently accepted', () => {
  expect(storedWagerResult(null)).toBeUndefined();
  for (const value of [
    undefined,
    [],
    'invalid',
    { status: 'UNKNOWN', httpStatus: 200 },
    { status: 'PROCESSED', httpStatus: undefined },
  ]) {
    expect(() => storedWagerResult(value)).toThrow(
      expect.objectContaining({ code: 'INVALID_PERSISTED_TRANSACTION' }),
    );
  }
});
