import { describe, expect, test } from 'bun:test';
import { Money } from '../money/money';
import { MoneyError } from '../money/money-error';
import { WalletError } from './wallet-error';
import {
  LedgerDirection,
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
  type WalletLedgerEntryState,
} from './wallet-ledger-entry';

const uuid = (suffix: string): string => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const at = (): Date => new Date('2026-10-27T12:00:00.000Z');
const money = (amount: string, currency = 'BRL'): Money => Money.rehydrate({ amount, currency });

function props(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: uuid('1'),
    walletId: uuid('2'),
    transactionId: uuid('3'),
    walletVersion: 2,
    direction: LedgerDirection.Debit,
    money: money('25.00'),
    balanceBefore: money('100.00'),
    balanceAfter: money('75.00'),
    createdAt: at(),
    ...overrides,
  };
}

function state(entry: WalletLedgerEntry): WalletLedgerEntryState {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt,
  };
}

function expectCode(
  action: () => unknown,
  code: string,
  kind: typeof WalletError | typeof MoneyError = WalletError,
): void {
  let error: unknown;
  try {
    action();
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).toBeInstanceOf(kind);
  expect(error).toMatchObject({ code });
}

describe('WalletLedgerEntry — SPEC-002 domain', () => {
  test('WAL-009 / WAL-017: preserves a balanced debit and its financial version', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletVersion).toBe(2);
    expect(entry.money.toString()).toBe('25.00 BRL');
    expect(entry.balanceBefore.toString()).toBe('100.00 BRL');
    expect(entry.balanceAfter.toString()).toBe('75.00 BRL');
    expect(entry.isBalanced()).toBe(true);
  });

  test('WAL-012 / WAL-017: validates exact credit arithmetic', () => {
    const entry = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        balanceAfter: money('125.00'),
      }),
    );
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toString()).toBe('125.00 BRL');
  });

  test('WAL-002 / WAL-003: the opening entry starts at zero in version one', () => {
    const entry = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        walletVersion: 1,
        money: money('100.00'),
        balanceBefore: Money.zero('BRL'),
        balanceAfter: money('100.00'),
      }),
    );
    expect(entry.isBalanced()).toBe(true);
    expect(entry.walletVersion).toBe(1);
    expect(entry.balanceBefore.isZero()).toBe(true);
  });

  test.each(
    [
      { direction: 'OTHER' },
      { money: Money.zero('BRL') },
      { money: money('-0.01') },
      { money: null },
      { money: { amount: '25.00', currency: 'BRL' } },
      { balanceBefore: money('-1.00') },
      { balanceAfter: money('-1.00') },
      { balanceBefore: null },
      { balanceAfter: undefined },
      { balanceAfter: money('75.01') },
      { balanceAfter: money('100.00') },
      { direction: LedgerDirection.Credit, balanceAfter: money('124.99') },
      { balanceBefore: Money.zero('BRL'), balanceAfter: Money.zero('BRL') },
      { walletVersion: 1 },
      { direction: LedgerDirection.Credit, walletVersion: 1, balanceAfter: money('125.00') },
      { id: 'bad' },
      { walletId: '' },
      { transactionId: 'bad' },
      { walletVersion: 0 },
      { walletVersion: -1 },
      { walletVersion: 1.5 },
      { walletVersion: Infinity },
      { walletVersion: Number.MAX_SAFE_INTEGER + 1 },
      { createdAt: new Date('invalid') },
      { createdAt: '2026-10-27T12:00:00.000Z' },
    ].map((patch) => ({ patch })),
  )('WAL-015 / WAL-017 / WAL-037: rejects invalid ledger transition %j', ({ patch }) =>
    expectCode(
      () => WalletLedgerEntry.create({ ...props(), ...patch } as CreateLedgerEntryProps),
      'INVALID_LEDGER_ENTRY',
    ),
  );

  test.each([null, undefined, [], {}].map((value) => ({ value })))(
    'WAL-017: rejects malformed ledger creation object %j',
    ({ value }) =>
      expectCode(
        () => WalletLedgerEntry.create(value as CreateLedgerEntryProps),
        'INVALID_LEDGER_ENTRY',
      ),
  );

  test.each(['money', 'balanceBefore', 'balanceAfter'] as const)(
    'WAL-014: currency mismatch in %s preserves the Money error',
    (field) => {
      const original = props();
      const mismatch = Money.from({ ...original[field].toJSON(), currency: 'USD' });
      expectCode(
        () => WalletLedgerEntry.create({ ...original, [field]: mismatch }),
        'CURRENCY_MISMATCH',
        MoneyError,
      );
      expect(original.balanceBefore.toString()).toBe('100.00 BRL');
      expect(original.balanceAfter.toString()).toBe('75.00 BRL');
    },
  );

  test('WAL-013: impossible credit arithmetic preserves the Money overflow error', () => {
    const maximum = money('999999999999999999.99');
    expectCode(
      () =>
        WalletLedgerEntry.create(
          props({
            direction: LedgerDirection.Credit,
            balanceBefore: maximum,
            money: money('0.01'),
            balanceAfter: maximum,
          }),
        ),
      'MONEY_OUT_OF_RANGE',
      MoneyError,
    );
    expect(maximum.toJSON().amount).toBe('999999999999999999.99');
  });

  test('WAL-017: exact cents near MAX remain balanced', () => {
    const entry = WalletLedgerEntry.create(
      props({
        money: money('0.01'),
        balanceBefore: money('999999999999999999.99'),
        balanceAfter: money('999999999999999999.98'),
      }),
    );
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toJSON().amount).toBe('999999999999999999.98');
  });

  test('WAL-029: rehydrates all fields without modifying the input or creating a movement', () => {
    const original = WalletLedgerEntry.create(props());
    const persisted = state(original);
    const restored = WalletLedgerEntry.rehydrate(persisted);
    expect(state(restored)).toEqual(persisted);
    expect(restored).not.toBe(original);
    persisted.money.amount = '99.00';
    persisted.balanceBefore.amount = '99.00';
    persisted.balanceAfter.amount = '99.00';
    persisted.createdAt.setTime(0);
    expect(restored.money.toString()).toBe('25.00 BRL');
    expect(restored.balanceBefore.toString()).toBe('100.00 BRL');
    expect(restored.balanceAfter.toString()).toBe('75.00 BRL');
    expect(restored.createdAt).toEqual(at());
  });

  test.each(
    [
      { id: '' },
      { walletId: 'bad' },
      { transactionId: 'bad' },
      { walletVersion: 0 },
      { walletVersion: 1 },
      { walletVersion: 1.5 },
      { walletVersion: Number.MAX_SAFE_INTEGER + 1 },
      { direction: 'OTHER' },
      { money: { amount: '0.00', currency: 'BRL' } },
      { money: { amount: '-1.00', currency: 'BRL' } },
      { money: { amount: '25.0', currency: 'BRL' } },
      { money: { amount: '1000000000000000000.00', currency: 'BRL' } },
      { money: { amount: '25.00', currency: 'USD' } },
      { money: { amount: '25.00', currency: 'EUR' } },
      { money: null },
      { balanceBefore: { amount: '-100.00', currency: 'BRL' } },
      { balanceBefore: { amount: '100.00', currency: 'USD' } },
      { balanceAfter: { amount: '-75.00', currency: 'BRL' } },
      { balanceAfter: { amount: '75.01', currency: 'BRL' } },
      { createdAt: new Date('invalid') },
      { createdAt: null },
    ].map((patch) => ({ patch })),
  )('WAL-029 / WAL-037: persisted corruption %j is a ledger integrity error', ({ patch }) =>
    expectCode(
      () =>
        WalletLedgerEntry.rehydrate({
          ...state(WalletLedgerEntry.create(props())),
          ...patch,
        } as WalletLedgerEntryState),
      'INVALID_PERSISTED_LEDGER_ENTRY',
    ),
  );

  test.each([null, undefined, [], {}].map((value) => ({ value })))(
    'WAL-029: rejects malformed persisted object %j',
    ({ value }) =>
      expectCode(
        () => WalletLedgerEntry.rehydrate(value as WalletLedgerEntryState),
        'INVALID_PERSISTED_LEDGER_ENTRY',
      ),
  );

  test('WAL-029: persisted arithmetic overflow is encapsulated as ledger corruption', () => {
    const persisted = state(WalletLedgerEntry.create(props()));
    expectCode(
      () =>
        WalletLedgerEntry.rehydrate({
          ...persisted,
          direction: LedgerDirection.Credit,
          money: { amount: '0.01', currency: 'BRL' },
          balanceBefore: { amount: '999999999999999999.99', currency: 'BRL' },
          balanceAfter: { amount: '999999999999999999.99', currency: 'BRL' },
        }),
      'INVALID_PERSISTED_LEDGER_ENTRY',
    );
  });

  test('WAL-017 / WAL-029: valid USD entries retain their currency', () => {
    const entry = WalletLedgerEntry.create(
      props({
        money: money('25.00', 'USD'),
        balanceBefore: money('100.00', 'USD'),
        balanceAfter: money('75.00', 'USD'),
      }),
    );
    expect(WalletLedgerEntry.rehydrate(state(entry)).money.currency).toBe('USD');
  });

  test('WAL-003 / WAL-017: entry fields and timestamp remain immutable', () => {
    const input = props();
    const entry = WalletLedgerEntry.create(input);
    const before = state(entry);
    input.createdAt.setTime(0);
    input.id = uuid('99');
    input.money = money('99.00');
    entry.createdAt.setTime(0);
    const output = entry.balanceBefore.toJSON();
    output.amount = '99.00';
    expect(state(entry)).toEqual(before);
    expect(Object.isFrozen(entry)).toBe(true);
    for (const field of [
      'id',
      'walletId',
      'transactionId',
      'walletVersion',
      'direction',
      'money',
      'balanceBefore',
      'balanceAfter',
      'createdAt',
    ]) {
      expect(Reflect.set(entry, field, null)).toBe(false);
    }
    expect(entry.isBalanced()).toBe(true);
  });
});
