import Decimal from 'decimal.js';
import { MoneyError } from './money-error';

export type Currency = 'BRL' | 'USD';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Reset all settings so global exponent limits cannot affect the private constructor.
const MoneyDecimal = Decimal.clone({ defaults: true, precision: 40 });
const maximum = new MoneyDecimal('999999999999999999.99');
const unsignedAmountPattern = /^(0|[1-9][0-9]*)\.[0-9]{2}$/;
const maximumUnsignedLength = 21;

export class Money {
  readonly #value: Decimal;

  private constructor(
    value: Decimal,
    public readonly currency: Currency,
  ) {
    this.#value = value.isZero() ? new MoneyDecimal('0.00') : value;
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    return Money.parse(props, false);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  static rehydrate(props: MoneyProps): Money {
    try {
      return Money.parse(props, true);
    } catch (error: unknown) {
      if (error instanceof MoneyError) {
        throw new MoneyError('INVALID_PERSISTED_MONEY');
      }
      throw error;
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromResult(this.#value.plus(other.#value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromResult(this.#value.minus(other.#value), this.currency);
  }

  negate(): Money {
    return Money.fromResult(this.#value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  isPositive(): boolean {
    return !this.isZero() && this.#value.isPositive();
  }

  isNegative(): boolean {
    return !this.isZero() && this.#value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.lessThan(other.#value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.equals(other.#value);
  }

  toJSON(): MoneyProps {
    return { amount: this.#value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.#value.toFixed(2)} ${this.currency}`;
  }

  private static parse(props: MoneyProps, allowNegative: boolean): Money {
    if (typeof props !== 'object' || props === null || Array.isArray(props)) {
      throw new MoneyError('INVALID_MONEY_AMOUNT');
    }

    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new MoneyError('INVALID_MONEY_AMOUNT');
    }

    const unsigned = allowNegative && amount.startsWith('-') ? amount.slice(1) : amount;
    if (!unsignedAmountPattern.test(unsigned)) {
      throw new MoneyError('INVALID_MONEY_AMOUNT');
    }

    // Reject oversized canonical inputs before passing them to Decimal.js.
    if (unsigned.length > maximumUnsignedLength) {
      throw new MoneyError('MONEY_OUT_OF_RANGE');
    }

    if (currency !== 'BRL' && currency !== 'USD') {
      throw new MoneyError('INVALID_CURRENCY');
    }

    return Money.fromResult(new MoneyDecimal(amount), currency);
  }

  private static fromResult(value: Decimal, currency: Currency): Money {
    if (!value.isFinite() || value.absoluteValue().greaterThan(maximum)) {
      throw new MoneyError('MONEY_OUT_OF_RANGE');
    }
    return new Money(value, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError('CURRENCY_MISMATCH');
    }
  }
}
