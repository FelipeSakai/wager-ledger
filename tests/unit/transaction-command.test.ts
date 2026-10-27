import { describe, expect, test } from 'bun:test';
import {
  canonicalTransaction,
  validateTransactionInput,
} from '../../src/modules/financial/application/transactions/transaction-command';
import { systemFinancialRuntime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';

const input = {
  walletId: '00000000-0000-4000-8000-000000000001',
  playerId: '00000000-0000-4000-8000-000000000002',
  providerId: 'provider-a',
  externalTransactionId: 'tx-123',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { currency: 'BRL', amount: '25.00' },
};
const expected =
  '{"externalTransactionId":"tx-123","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"00000000-0000-4000-8000-000000000002","providerId":"provider-a","referenceExternalTransactionId":null,"roundId":"round-1","walletId":"00000000-0000-4000-8000-000000000001"}';
describe('PROC-D01: SHA-256/JSON-v1 business contract', () => {
  test('PROC-009: canonical JSON is an explicit stable string independent of insertion order and key', () => {
    expect(canonicalTransaction(validateTransactionInput(input, 'key-a').command)).toBe(expected);
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    expect(canonicalTransaction(validateTransactionInput(reordered, 'key-b').command)).toBe(
      expected,
    );
    expect(systemFinancialRuntime.sha256(expected)).toBe(
      '2d015433c9f5bc94af0d16daafe13d75c590f5fdee4bb1a416e1fc5e37bc70e1',
    );
  });
  test.each([
    'providerId',
    'externalTransactionId',
    'playerId',
    'walletId',
    'roundId',
    'gameId',
    'kind',
  ] as const)('changing %s changes the business hash', (field) => {
    const changed = {
      ...input,
      [field]:
        field === 'kind'
          ? 'WIN'
          : field.endsWith('Id') && ['walletId', 'playerId'].includes(field)
            ? '00000000-0000-4000-8000-000000000003'
            : `${input[field]}-changed`,
    };
    expect(canonicalTransaction(validateTransactionInput(changed, 'key').command)).not.toBe(
      expected,
    );
  });
  test.each([undefined, null, '', ' key', 'key ', 'k'.repeat(256), 25])(
    'PROC-010: reject invalid key %s',
    (key) => {
      expect(() => validateTransactionInput(input, key)).toThrow(
        expect.objectContaining({ code: 'INVALID_IDEMPOTENCY_KEY' }),
      );
    },
  );
  test.each([
    { origin: 'INTERNAL' },
    { status: 'PROCESSED' },
    { balance: '1.00' },
    { correlationId: 'x' },
    { providerId: ' provider-a' },
    { providerId: 'provider.a' },
    { externalTransactionId: '' },
    { walletId: 'x' },
    { playerId: null },
    { roundId: 'x'.repeat(129) },
    { gameId: ' x' },
    { kind: 'OPENING' },
    { referenceExternalTransactionId: null },
    { referenceExternalTransactionId: 'ref' },
    { money: { amount: '1.00', currency: 'BRL', extra: true } },
  ])('reject invalid input without admission', (changed) => {
    expect(() => validateTransactionInput({ ...input, ...changed }, 'key')).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSACTION_INPUT' }),
    );
  });
  test.each([25, '25', '25.0', '-25.00', 'NaN', '1e2'])(
    'reject malformed money %s before admission',
    (amount) => {
      expect(() =>
        validateTransactionInput({ ...input, money: { amount, currency: 'BRL' } }, 'key'),
      ).toThrow(expect.objectContaining({ code: 'INVALID_MONEY_AMOUNT' }));
    },
  );
  test('application admits BRL only and rejects unknown currencies with the Money code', () => {
    expect(() =>
      validateTransactionInput({ ...input, money: { amount: '25.00', currency: 'USD' } }, 'key'),
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_TRANSACTION_CURRENCY' }));
    expect(() =>
      validateTransactionInput({ ...input, money: { amount: '25.00', currency: 'ZZZ' } }, 'key'),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CURRENCY' }));
  });
  test('null is not an omitted reference and references change the hash', () => {
    const win = { ...input, kind: 'WIN' };
    const without = canonicalTransaction(validateTransactionInput(win, 'key').command);
    const withRef = canonicalTransaction(
      validateTransactionInput({ ...win, referenceExternalTransactionId: 'ref' }, 'key').command,
    );
    expect(withRef).not.toBe(without);
    expect(() =>
      validateTransactionInput({ ...win, referenceExternalTransactionId: null }, 'key'),
    ).toThrow();
    for (const kind of ['REFUND', 'ROLLBACK'])
      expect(() => validateTransactionInput({ ...input, kind }, 'key')).toThrow();
  });
});
