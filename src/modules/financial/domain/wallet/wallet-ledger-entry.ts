import { Money, type MoneyProps } from '../money/money';
import { MoneyError } from '../money/money-error';
import { isRecord, isTimestamp, isUuid, isWalletVersion } from '../validation/domain-validation';
import { WalletError } from './wallet-error';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  walletVersion: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface WalletLedgerEntryState extends Omit<
  CreateLedgerEntryProps,
  'money' | 'balanceBefore' | 'balanceAfter'
> {
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
}

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly walletVersion: number;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly #createdAt: number;

  private constructor(props: CreateLedgerEntryProps) {
    this.id = props.id;
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.walletVersion = props.walletVersion;
    this.direction = props.direction;
    this.money = props.money;
    this.balanceBefore = props.balanceBefore;
    this.balanceAfter = props.balanceAfter;
    this.#createdAt = props.createdAt.getTime();
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (
      !isRecord(props) ||
      !isUuid(props.id) ||
      !isUuid(props.walletId) ||
      !isUuid(props.transactionId) ||
      !isWalletVersion(props.walletVersion) ||
      !isTimestamp(props.createdAt) ||
      (props.direction !== LedgerDirection.Debit && props.direction !== LedgerDirection.Credit) ||
      !(props.money instanceof Money) ||
      !props.money.isPositive() ||
      !(props.balanceBefore instanceof Money) ||
      props.balanceBefore.isNegative() ||
      !(props.balanceAfter instanceof Money) ||
      props.balanceAfter.isNegative()
    ) {
      throw new WalletError('INVALID_LEDGER_ENTRY');
    }

    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new MoneyError('CURRENCY_MISMATCH');
    }

    if (
      props.walletVersion === 1 &&
      (props.direction !== LedgerDirection.Credit || !props.balanceBefore.isZero())
    ) {
      throw new WalletError('INVALID_LEDGER_ENTRY');
    }

    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) {
      throw new WalletError('INVALID_LEDGER_ENTRY');
    }
    return entry;
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    try {
      if (!isRecord(state)) {
        throw new WalletError('INVALID_PERSISTED_LEDGER_ENTRY');
      }
      return WalletLedgerEntry.create({
        id: state.id,
        walletId: state.walletId,
        transactionId: state.transactionId,
        walletVersion: state.walletVersion,
        direction: state.direction,
        money: Money.rehydrate(state.money),
        balanceBefore: Money.rehydrate(state.balanceBefore),
        balanceAfter: Money.rehydrate(state.balanceAfter),
        createdAt: state.createdAt,
      });
    } catch (error: unknown) {
      if (error instanceof WalletError || error instanceof MoneyError) {
        throw new WalletError('INVALID_PERSISTED_LEDGER_ENTRY');
      }
      throw error;
    }
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
