import { describe, expect, test } from 'bun:test';
import { Money } from '../money/money';
import { MoneyError } from '../money/money-error';
import { Wallet, type OpenWalletProps, type WalletMovement, type WalletState } from './wallet';
import { WalletError } from './wallet-error';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

const uuid = (suffix: string): string => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const createdAt = (): Date => new Date('2026-10-27T12:00:00.000Z');
const movedAt = (): Date => new Date('2026-10-27T12:00:01.000Z');
const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });
const negativeMoney = (): Money => Money.rehydrate({ amount: '-0.01', currency: 'BRL' });

function openProps(overrides: Partial<OpenWalletProps> = {}): OpenWalletProps {
  return {
    id: uuid('1'),
    playerId: uuid('2'),
    initialBalance: money('100.00'),
    at: createdAt(),
    ...overrides,
  };
}

function movement(overrides: Partial<WalletMovement> = {}): WalletMovement {
  return {
    ledgerEntryId: uuid('3'),
    transactionId: uuid('4'),
    money: money('25.00'),
    at: movedAt(),
    ...overrides,
  };
}

function state(wallet: Wallet): WalletState {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
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

describe('Wallet — SPEC-002 domain', () => {
  test('WAL-001: opens a zero wallet at version one', () => {
    const wallet = Wallet.open(openProps({ initialBalance: Money.zero('BRL') }));
    expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(createdAt());
    expect(wallet.updatedAt).toEqual(createdAt());
  });

  test('WAL-002 / WAL-003: opens a positive wallet and supports its version-one opening entry', () => {
    const wallet = Wallet.open(openProps());
    const opening = WalletLedgerEntry.create({
      id: uuid('5'),
      walletId: wallet.id,
      transactionId: uuid('6'),
      walletVersion: wallet.version,
      direction: LedgerDirection.Credit,
      money: wallet.balance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance,
      createdAt: wallet.createdAt,
    });
    expect(wallet.balance.toString()).toBe('100.00 BRL');
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(wallet.updatedAt);
    expect(opening.walletVersion).toBe(1);
    expect(opening.balanceBefore.toString()).toBe('0.00 BRL');
    expect(opening.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(opening.isBalanced()).toBe(true);
  });

  test('WAL-007: the domain can represent and move a USD wallet', () => {
    const wallet = Wallet.open(openProps({ initialBalance: money('10.00', 'USD') }));
    const entry = wallet.credit(movement({ money: money('5.00', 'USD') }));
    expect(wallet.currency).toBe('USD');
    expect(wallet.balance.toString()).toBe('15.00 USD');
    expect(entry.money.currency).toBe('USD');
  });

  test.each([null, undefined, [], {}, 'wallet'].map((props) => ({ props })))(
    'WAL-008 / WAL-037: rejects malformed opening props %j',
    ({ props }) => expectCode(() => Wallet.open(props as OpenWalletProps), 'INVALID_WALLET_INPUT'),
  );

  test.each(
    [
      { id: 'invalid' },
      { id: `${uuid('1')}x` },
      { playerId: '' },
      { playerId: ` ${uuid('2')}` },
      { initialBalance: negativeMoney() },
      { initialBalance: null },
      { initialBalance: { amount: '100.00', currency: 'BRL' } },
      { at: new Date('invalid') },
      { at: '2026-10-27T12:00:00.000Z' },
    ].map((patch) => ({ patch })),
  )('WAL-008 / WAL-037: rejects invalid opening state %j', ({ patch }) =>
    expectCode(
      () => Wallet.open({ ...openProps(), ...patch } as OpenWalletProps),
      'INVALID_WALLET_INPUT',
    ),
  );

  test('WAL-008: invalid external money is rejected before wallet creation', () => {
    for (const amount of ['-1.00', '1.001', 'NaN']) {
      expectCode(
        () => Wallet.open(openProps({ initialBalance: money(amount) })),
        'INVALID_MONEY_AMOUNT',
        MoneyError,
      );
    }
    expectCode(
      () => Wallet.open(openProps({ initialBalance: money('1000000000000000000.00') })),
      'MONEY_OUT_OF_RANGE',
      MoneyError,
    );
  });

  test('WAL-009: debit returns the exact entry and advances state once', () => {
    const wallet = Wallet.open(openProps());
    const entry = wallet.debit(movement());
    expect(wallet.balance.toString()).toBe('75.00 BRL');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(movedAt());
    expect(wallet.createdAt).toEqual(createdAt());
    expect(entry.id).toBe(uuid('3'));
    expect(entry.walletId).toBe(wallet.id);
    expect(entry.transactionId).toBe(uuid('4'));
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletVersion).toBe(2);
    expect(entry.money.toString()).toBe('25.00 BRL');
    expect(entry.balanceBefore.toString()).toBe('100.00 BRL');
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.createdAt).toEqual(wallet.updatedAt);
  });

  test('WAL-010: debit of the entire balance leaves zero', () => {
    const wallet = Wallet.open(openProps());
    const entry = wallet.debit(movement({ money: money('100.00') }));
    expect(wallet.balance.toString()).toBe('0.00 BRL');
    expect(wallet.version).toBe(2);
    expect(entry.balanceAfter.isZero()).toBe(true);
    expect(entry.isBalanced()).toBe(true);
  });

  test('WAL-011: insufficient funds preserve every state field', () => {
    const wallet = Wallet.open(openProps());
    const before = state(wallet);
    expectCode(() => wallet.debit(movement({ money: money('100.01') })), 'INSUFFICIENT_FUNDS');
    expect(state(wallet)).toEqual(before);
  });

  test('WAL-012: credit returns the exact entry and advances state once', () => {
    const wallet = Wallet.open(openProps());
    const entry = wallet.credit(movement({ money: money('10.00') }));
    expect(wallet.balance.toString()).toBe('110.00 BRL');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('100.00 BRL');
    expect(entry.balanceAfter.toString()).toBe('110.00 BRL');
    expect(entry.money.toString()).toBe('10.00 BRL');
    expect(entry.walletVersion).toBe(wallet.version);
    expect(wallet.updatedAt).toEqual(entry.createdAt);
  });

  test('WAL-013: balance overflow preserves the aggregate and Money error', () => {
    const wallet = Wallet.open(openProps({ initialBalance: money('999999999999999999.99') }));
    const before = state(wallet);
    expectCode(
      () => wallet.credit(movement({ money: money('0.01') })),
      'MONEY_OUT_OF_RANGE',
      MoneyError,
    );
    expect(state(wallet)).toEqual(before);
  });

  for (const method of ['debit', 'credit'] as const) {
    describe(method, () => {
      test('WAL-014: currency mismatch preserves the complete state', () => {
        const wallet = Wallet.open(openProps());
        const before = state(wallet);
        expectCode(
          () => wallet[method](movement({ money: money('1.00', 'USD') })),
          'CURRENCY_MISMATCH',
          MoneyError,
        );
        expect(state(wallet)).toEqual(before);
      });

      test.each(
        [
          Money.zero('BRL'),
          negativeMoney(),
          null,
          undefined,
          { amount: '1.00', currency: 'BRL' },
        ].map((value) => ({ value })),
      )('WAL-015: rejects invalid movement money %j without mutation', ({ value }) => {
        const wallet = Wallet.open(openProps());
        const before = state(wallet);
        expectCode(
          () => wallet[method](movement({ money: value as Money })),
          'INVALID_MOVEMENT_AMOUNT',
        );
        expect(state(wallet)).toEqual(before);
      });

      test.each([null, undefined, [], {}].map((value) => ({ value })))(
        'WAL-015 / WAL-037: rejects malformed movement %j',
        ({ value }) => {
          const wallet = Wallet.open(openProps());
          const before = state(wallet);
          expectCode(() => wallet[method](value as WalletMovement), 'INVALID_MOVEMENT_AMOUNT');
          expect(state(wallet)).toEqual(before);
        },
      );

      test.each(
        [
          { ledgerEntryId: 'bad' },
          { transactionId: 'bad' },
          { at: new Date('invalid') },
          { at: null },
        ].map((patch) => ({ patch })),
      )('WAL-037: invalid ledger metadata %j cannot partially change the wallet', ({ patch }) => {
        const wallet = Wallet.open(openProps());
        const before = state(wallet);
        expectCode(
          () => wallet[method]({ ...movement(), ...patch } as WalletMovement),
          'INVALID_LEDGER_ENTRY',
        );
        expect(state(wallet)).toEqual(before);
      });

      test('rejects exhausted numeric versions without a partial movement', () => {
        const wallet = Wallet.rehydrate({
          ...state(Wallet.open(openProps())),
          version: Number.MAX_SAFE_INTEGER,
        });
        const before = state(wallet);
        expect(() => wallet[method](movement())).toThrow(RangeError);
        expect(state(wallet)).toEqual(before);
      });
    });
  }

  test('WAL-026: first movement after zero opening produces version two', () => {
    const wallet = Wallet.open(openProps({ initialBalance: Money.zero('BRL') }));
    const entry = wallet.credit(movement({ money: money('50.00') }));
    expect(wallet.version).toBe(2);
    expect(entry.walletVersion).toBe(2);
    expect(entry.balanceBefore.isZero()).toBe(true);
    expect(entry.balanceAfter.toString()).toBe('50.00 BRL');
  });

  test('WAL-028: a domain movement sequence reconstructs its balance from the returned entries', () => {
    const wallet = Wallet.open(openProps());
    const opening = WalletLedgerEntry.create({
      id: uuid('10'),
      walletId: wallet.id,
      transactionId: uuid('11'),
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: wallet.balance,
      balanceBefore: Money.zero('BRL'),
      balanceAfter: wallet.balance,
      createdAt: wallet.createdAt,
    });
    const entries = [
      opening,
      wallet.debit(movement({ ledgerEntryId: uuid('12'), transactionId: uuid('13') })),
      wallet.credit(
        movement({ ledgerEntryId: uuid('14'), transactionId: uuid('15'), money: money('10.00') }),
      ),
      wallet.debit(
        movement({ ledgerEntryId: uuid('16'), transactionId: uuid('17'), money: money('85.00') }),
      ),
    ];
    let reconstructed = Money.zero('BRL');
    for (const [index, entry] of entries.entries()) {
      expect(entry.walletVersion).toBe(index + 1);
      expect(entry.balanceBefore.equals(reconstructed)).toBe(true);
      reconstructed =
        entry.direction === LedgerDirection.Credit
          ? reconstructed.add(entry.money)
          : reconstructed.subtract(entry.money);
      expect(entry.balanceAfter.equals(reconstructed)).toBe(true);
    }
    expect(reconstructed.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(4);
    expect(opening.balanceAfter.toString()).toBe('100.00 BRL');
  });

  test('WAL-029: rehydration preserves identity, state and timestamps without applying a movement', () => {
    const original = Wallet.open(openProps());
    original.debit(movement());
    const persisted = state(original);
    const restored = Wallet.rehydrate(persisted);
    expect(state(restored)).toEqual(persisted);
    expect(restored).not.toBe(original);
    persisted.balance.amount = '99.00';
    persisted.createdAt.setTime(0);
    persisted.updatedAt.setTime(0);
    expect(restored.balance.toString()).toBe('75.00 BRL');
    expect(restored.createdAt).toEqual(createdAt());
    expect(restored.updatedAt).toEqual(movedAt());
  });

  test.each(
    [
      { id: '' },
      { playerId: 'bad' },
      { currency: 'USD' },
      { currency: 'brl' },
      { balance: { amount: '-0.01', currency: 'BRL' } },
      { balance: { amount: '1.001', currency: 'BRL' } },
      { balance: { amount: '1000000000000000000.00', currency: 'BRL' } },
      { balance: { amount: '1.00', currency: 'EUR' } },
      { balance: null },
      { version: 0 },
      { version: -1 },
      { version: 1.5 },
      { version: NaN },
      { version: Infinity },
      { version: Number.MAX_SAFE_INTEGER + 1 },
      { version: '1' },
      { createdAt: new Date('invalid') },
      { updatedAt: new Date('invalid') },
      { updatedAt: '2026-10-27T12:00:01.000Z' },
    ].map((patch) => ({ patch })),
  )('WAL-029 / WAL-037: corrupt persisted state %j is not a client money error', ({ patch }) =>
    expectCode(
      () => Wallet.rehydrate({ ...state(Wallet.open(openProps())), ...patch } as WalletState),
      'INVALID_PERSISTED_WALLET',
    ),
  );

  test.each([null, undefined, [], {}].map((value) => ({ value })))(
    'WAL-029: rejects malformed persisted object %j',
    ({ value }) =>
      expectCode(() => Wallet.rehydrate(value as WalletState), 'INVALID_PERSISTED_WALLET'),
  );

  test('WAL-003 / WAL-037: dates and immutable identity cannot be changed through external references', () => {
    const props = openProps();
    const wallet = Wallet.open(props);
    props.at.setTime(0);
    props.id = uuid('99');
    props.playerId = uuid('98');
    wallet.createdAt.setTime(0);
    wallet.updatedAt.setTime(0);
    expect(wallet.id).toBe(uuid('1'));
    expect(wallet.playerId).toBe(uuid('2'));
    expect(wallet.createdAt).toEqual(createdAt());
    expect(wallet.updatedAt).toEqual(createdAt());
    for (const key of [
      'id',
      'playerId',
      'currency',
      'balance',
      'version',
      'createdAt',
      'updatedAt',
    ]) {
      expect(Reflect.set(wallet, key, null)).toBe(false);
    }
    const time = movedAt();
    const entry = wallet.credit(movement({ at: time }));
    time.setTime(0);
    entry.createdAt.setTime(0);
    expect(wallet.updatedAt).toEqual(movedAt());
    expect(wallet.createdAt).toEqual(createdAt());
  });

  test('WAL-003 / WAL-009: equal timestamps do not replace financial version ordering', () => {
    const wallet = Wallet.open(openProps());
    const first = wallet.debit(movement({ at: createdAt() }));
    const second = wallet.credit(
      movement({ ledgerEntryId: uuid('20'), transactionId: uuid('21'), at: createdAt() }),
    );
    expect(first.walletVersion).toBe(2);
    expect(second.walletVersion).toBe(3);
    expect(first.createdAt).toEqual(second.createdAt);
    expect(wallet.balance.toString()).toBe('100.00 BRL');
    expect(wallet.version).toBe(3);
    expect(first.balanceAfter.toString()).toBe('75.00 BRL');
  });

  test('accepts UUID identities without imposing a single version', () => {
    const wallet = Wallet.open(
      openProps({
        id: '0192f291-27dd-7d3f-8071-5f8685deef37',
        playerId: '550E8400-E29B-41D4-A716-446655440000',
      }),
    );
    expect(wallet.id).toBe('0192f291-27dd-7d3f-8071-5f8685deef37');
    expect(wallet.playerId).toBe('550E8400-E29B-41D4-A716-446655440000');
  });

  test('WAL-003: timestamp offsets preserve the same UTC instant', () => {
    const wallet = Wallet.open(openProps({ at: new Date('2026-10-27T08:00:00.000-04:00') }));
    const entry = wallet.credit(movement({ at: new Date('2026-10-27T15:00:01.000+03:00') }));
    expect(wallet.createdAt.toISOString()).toBe('2026-10-27T12:00:00.000Z');
    expect(wallet.updatedAt.toISOString()).toBe('2026-10-27T12:00:01.000Z');
    expect(entry.createdAt.toISOString()).toBe('2026-10-27T12:00:01.000Z');
  });
});
