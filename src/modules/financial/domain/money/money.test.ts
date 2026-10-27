import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Money, type MoneyProps } from './money';
import { MoneyError, type MoneyErrorCode } from './money-error';

const maximum = '999999999999999999.99';
const from = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });
const restore = (amount: string, currency = 'BRL'): Money => Money.rehydrate({ amount, currency });

function expectCode(action: () => unknown, code: MoneyErrorCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MoneyError);
  expect(caught).toMatchObject({ code, name: 'MoneyError' });
}

describe('Money — SPEC-001', () => {
  test('MNY-001: preserves a canonical amount and its currency', () => {
    const money = from('25.00');
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(money.currency).toBe('BRL');
  });

  test('MNY-002: adds decimal fractions exactly', () => {
    expect(from('0.10').add(from('0.20')).toJSON().amount).toBe('0.30');
  });

  test('MNY-003: subtraction can produce an exact negative internal value', () => {
    const difference = from('0.10').subtract(from('0.20'));
    expect(difference.toJSON().amount).toBe('-0.10');
    expect(difference.isNegative()).toBe(true);
    expect(difference.isPositive()).toBe(false);
  });

  test('MNY-004: preserves cents above the safe integer range', () => {
    expect(from('9007199254740993.01').add(from('0.09')).toJSON().amount).toBe(
      '9007199254740993.10',
    );
  });

  const invalidAmounts: unknown[] = [
    25,
    25.5,
    NaN,
    Infinity,
    null,
    undefined,
    true,
    {},
    [],
    '25',
    '25.0',
    '.50',
    '01.00',
    '00.00',
    '+1.00',
    ' 1.00',
    '1.00 ',
    '\t1.00',
    '1.00\n',
    '1.00\r',
    '1.00\u2028',
    '-1.00',
    '-0.00',
    '1.001',
    '1e2',
    'NaN',
    'Infinity',
    '',
    '1,00',
    '1,000.00',
    'R$ 1.00',
    '１.00',
    '1.٠٠',
    '0x10.00',
  ];

  test.each(invalidAmounts.map((amount) => ({ amount })))(
    'MNY-005: rejects invalid external amount %j',
    ({ amount }) => {
      expectCode(
        () => Money.from({ amount, currency: 'BRL' } as MoneyProps),
        'INVALID_MONEY_AMOUNT',
      );
    },
  );

  test.each([null, undefined, [], {}, { currency: 'BRL' }].map((props) => ({ props })))(
    'MNY-005: rejects a missing or malformed input object %j',
    ({ props }) => expectCode(() => Money.from(props as MoneyProps), 'INVALID_MONEY_AMOUNT'),
  );

  test('MNY-006: zero and negated zero are neither positive nor negative', () => {
    for (const zero of [Money.zero('BRL'), Money.zero('BRL').negate()]) {
      expect(zero.toJSON().amount).toBe('0.00');
      expect(zero.isZero()).toBe(true);
      expect(zero.isPositive()).toBe(false);
      expect(zero.isNegative()).toBe(false);
    }
  });

  test('MNY-007: compares equal, positive and negative values', () => {
    const one = from('1.00');
    expect(one.equals(one)).toBe(true);
    expect(one.equals(from('1.00'))).toBe(true);
    expect(one.equals(from('2.00'))).toBe(false);
    expect(one.isLessThan(from('2.00'))).toBe(true);
    expect(one.isLessThan(from('1.00'))).toBe(false);
    expect(restore('-2.00').isLessThan(restore('-1.00'))).toBe(true);
    expect(one.isPositive()).toBe(true);
    expect(one.isNegative()).toBe(false);
  });

  test('MNY-008 / MNY-009: every binary operation rejects different currencies', () => {
    const brl = from('1.00', 'BRL');
    const usd = from('1.00', 'USD');
    for (const [left, right] of [
      [brl, usd],
      [usd, brl],
    ] as const) {
      expectCode(() => left.add(right), 'CURRENCY_MISMATCH');
      expectCode(() => left.subtract(right), 'CURRENCY_MISMATCH');
      expectCode(() => left.isLessThan(right), 'CURRENCY_MISMATCH');
      expectCode(() => left.equals(right), 'CURRENCY_MISMATCH');
    }
    expect(brl.toString()).toBe('1.00 BRL');
    expect(usd.toString()).toBe('1.00 USD');
  });

  test('MNY-010: arithmetic, input mutation and output mutation preserve the original', () => {
    const input = { amount: '10.00', currency: 'BRL' };
    const original = Money.from(input);
    const other = from('2.00');
    const sum = original.add(other);
    const difference = original.subtract(other);
    const negative = original.negate();
    input.amount = '99.00';
    input.currency = 'USD';
    const output = original.toJSON();
    output.amount = '99.00';
    output.currency = 'USD';

    expect(original.toString()).toBe('10.00 BRL');
    expect(other.toString()).toBe('2.00 BRL');
    expect(sum.toString()).toBe('12.00 BRL');
    expect(difference.toString()).toBe('8.00 BRL');
    expect(negative.toString()).toBe('-10.00 BRL');
    for (const result of [sum, difference, negative, original.add(Money.zero('BRL'))]) {
      expect(result).not.toBe(original);
    }
    expect(Object.isFrozen(original)).toBe(true);
    expect(Reflect.set(original, 'currency', 'USD')).toBe(false);
    expect(Object.keys(original)).toEqual(['currency']);
  });

  test('MNY-011: reconstruction accepts exact signed values without changing external validation', () => {
    expect(restore('25.00').toString()).toBe('25.00 BRL');
    expect(restore('-0.10').toString()).toBe('-0.10 BRL');
    expectCode(() => from('-0.10'), 'INVALID_MONEY_AMOUNT');
  });

  const corruptProps: unknown[] = [
    null,
    undefined,
    [],
    {},
    ...invalidAmounts
      .filter((amount) => amount !== '-1.00' && amount !== '-0.00')
      .map((amount) => ({ amount, currency: 'BRL' })),
    { amount: '-01.00', currency: 'BRL' },
    { amount: '--1.00', currency: 'BRL' },
    { amount: '1000000000000000000.00', currency: 'BRL' },
    { amount: '-1000000000000000000.00', currency: 'BRL' },
    { amount: '1.00', currency: 'EUR' },
    { amount: '1.00' },
  ];

  test.each(corruptProps.map((props) => ({ props })))(
    'MNY-012: reports corrupted persisted data as %j',
    ({ props }) => {
      expectCode(() => Money.rehydrate(props as MoneyProps), 'INVALID_PERSISTED_MONEY');
    },
  );

  test('MNY-013: preserves both magnitude boundaries exactly', () => {
    expect(from(maximum).add(Money.zero('BRL')).toJSON().amount).toBe(maximum);
    expect(restore(`-${maximum}`).subtract(Money.zero('BRL')).toJSON().amount).toBe(`-${maximum}`);
    expect(from(maximum).negate().negate().toJSON().amount).toBe(maximum);
    expect(from(maximum).subtract(from(maximum)).toJSON().amount).toBe('0.00');
  });

  test('MNY-014: rejects positive and negative overflow without modifying operands', () => {
    const positive = from(maximum);
    const negative = positive.negate();
    const cent = from('0.01');
    expectCode(() => positive.add(cent), 'MONEY_OUT_OF_RANGE');
    expectCode(() => negative.subtract(cent), 'MONEY_OUT_OF_RANGE');
    expectCode(() => positive.subtract(negative), 'MONEY_OUT_OF_RANGE');
    expectCode(() => negative.add(negative), 'MONEY_OUT_OF_RANGE');
    expect(positive.toJSON().amount).toBe(maximum);
    expect(negative.toJSON().amount).toBe(`-${maximum}`);
    expect(cent.toJSON().amount).toBe('0.01');
  });

  test.each(
    ['brl', ' BRL', 'BRL ', 'EUR', '', 'BR', 'B RL', null, undefined, 25, {}, []].map(
      (currency) => ({ currency }),
    ),
  )('MNY-015: rejects currency outside the exact local catalog %j', ({ currency }) => {
    expectCode(() => Money.from({ amount: '1.00', currency } as MoneyProps), 'INVALID_CURRENCY');
    expectCode(() => Money.zero(currency as string), 'INVALID_CURRENCY');
    expectCode(
      () => Money.rehydrate({ amount: '1.00', currency } as MoneyProps),
      'INVALID_PERSISTED_MONEY',
    );
  });

  test.each(['0.00', '0.01', '25.00', '-0.01', `-${maximum}`, maximum])(
    'MNY-016: serializes exactly two places for %s',
    (amount) => {
      const money = restore(amount);
      expect(money.toJSON()).toEqual({ amount, currency: 'BRL' });
      expect(JSON.stringify(money)).toBe(JSON.stringify({ amount, currency: 'BRL' }));
      expect(money.toString()).toBe(`${amount} BRL`);
    },
  );

  test.each(['0.00', '0.01', '25.00', maximum])('MNY-017: round-trips %s', (amount) => {
    const original = from(amount);
    const rebuilt = Money.from(original.toJSON());
    expect(rebuilt.equals(original)).toBe(true);
    expect(rebuilt).not.toBe(original);
    expect(original.toJSON()).not.toBe(original.toJSON());
  });

  test.each(['0.00', '0.01', '-0.01', '123456789012345678.90', `-${maximum}`, maximum])(
    'MNY-018: preserves additive inverse identities for %s',
    (amount) => {
      const value = restore(amount);
      expect(value.negate().negate().equals(value)).toBe(true);
      expect(value.add(value.negate()).toJSON().amount).toBe('0.00');
      expect(value.subtract(value).toJSON().amount).toBe('0.00');
    },
  );

  test.each(['1000000000000000000.00', `${'9'.repeat(100_000)}.99`])(
    'MNY-019: rejects a canonical amount beyond the supported input length',
    (amount) => expectCode(() => from(amount), 'MONEY_OUT_OF_RANGE'),
  );

  test('MNY-020: later global Decimal configuration cannot affect Money', () => {
    const previous = {
      precision: Decimal.precision,
      rounding: Decimal.rounding,
      minE: Decimal.minE,
      maxE: Decimal.maxE,
      toExpNeg: Decimal.toExpNeg,
      toExpPos: Decimal.toExpPos,
    };
    try {
      Decimal.set({
        precision: 1,
        rounding: Decimal.ROUND_DOWN,
        minE: -1,
        maxE: 1,
        toExpNeg: 0,
        toExpPos: 0,
      });
      expect(from('9007199254740993.01').add(from('0.09')).toJSON().amount).toBe(
        '9007199254740993.10',
      );
      expect(from('0.01').add(from('0.02')).toJSON().amount).toBe('0.03');
      expect(from(maximum).subtract(from('0.01')).toJSON().amount).toBe('999999999999999999.98');
    } finally {
      Decimal.set(previous);
    }
  });

  test('MNY-020: configuration changed before module initialization is also isolated', () => {
    const modulePath = JSON.stringify(Bun.resolveSync('./money.ts', __dirname));
    const result = Bun.spawnSync(
      [
        process.execPath,
        '--eval',
        `import Decimal from 'decimal.js';
       Decimal.set({ precision: 1, minE: -1, maxE: 1 });
       const { Money } = await import(${modulePath});
       const sum = Money.from({ amount: '9007199254740993.01', currency: 'BRL' })
         .add(Money.from({ amount: '0.09', currency: 'BRL' }));
       console.log(sum.toString());`,
      ],
      { cwd: __dirname },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('9007199254740993.10 BRL');
  });

  test.each(['BRL', 'USD'])('MNY-021: represents supported domain currency %s', (currency) => {
    expect(from('1.00', currency).add(from('2.00', currency)).toJSON()).toEqual({
      amount: '3.00',
      currency,
    });
  });

  test('MNY-022: negative external zero is rejected and persisted zero is normalized', () => {
    expectCode(() => from('-0.00'), 'INVALID_MONEY_AMOUNT');
    const zero = restore('-0.00');
    expect(zero.toString()).toBe('0.00 BRL');
    expect(zero.negate().toJSON().amount).toBe('0.00');
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  test('error messages are stable and do not expose supplied values or library errors', () => {
    try {
      from('sensitive-invalid-value');
      throw new Error('Expected MoneyError');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(MoneyError);
      expect((error as Error).message).toBe(
        'Amount must be a non-negative canonical decimal string with two decimal places',
      );
      expect((error as Error).message).not.toContain('sensitive-invalid-value');
      expect((error as Error).message).not.toContain('DecimalError');
    }
  });
});
