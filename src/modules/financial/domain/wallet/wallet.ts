import { Money, type Currency, type MoneyProps } from '../money/money';
import { MoneyError } from '../money/money-error';
import { isRecord, isTimestamp, isUuid, isWalletVersion } from '../validation/domain-validation';
import { WalletError } from './wallet-error';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  ledgerEntryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: Currency;
  readonly #createdAt: number;
  #balance: Money;
  #version: number;
  #updatedAt: number;

  private constructor(
    id: string,
    playerId: string,
    balance: Money,
    version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this.id = id;
    this.playerId = playerId;
    this.currency = balance.currency;
    this.#balance = balance;
    this.#version = version;
    this.#createdAt = createdAt.getTime();
    this.#updatedAt = updatedAt.getTime();
    Object.freeze(this);
  }

  static open(props: OpenWalletProps): Wallet {
    if (
      !isRecord(props) ||
      !isUuid(props.id) ||
      !isUuid(props.playerId) ||
      !(props.initialBalance instanceof Money) ||
      props.initialBalance.isNegative() ||
      !isTimestamp(props.at)
    ) {
      throw new WalletError('INVALID_WALLET_INPUT');
    }
    return new Wallet(props.id, props.playerId, props.initialBalance, 1, props.at, props.at);
  }

  static rehydrate(state: WalletState): Wallet {
    try {
      if (
        !isRecord(state) ||
        !isUuid(state.id) ||
        !isUuid(state.playerId) ||
        !isWalletVersion(state.version) ||
        !isTimestamp(state.createdAt) ||
        !isTimestamp(state.updatedAt)
      ) {
        throw new WalletError('INVALID_PERSISTED_WALLET');
      }
      const balance = Money.rehydrate(state.balance);
      if (balance.isNegative() || state.currency !== balance.currency) {
        throw new WalletError('INVALID_PERSISTED_WALLET');
      }
      return new Wallet(
        state.id,
        state.playerId,
        balance,
        state.version,
        state.createdAt,
        state.updatedAt,
      );
    } catch (error: unknown) {
      if (error instanceof WalletError || error instanceof MoneyError) {
        throw new WalletError('INVALID_PERSISTED_WALLET');
      }
      throw error;
    }
  }

  get balance(): Money {
    return this.#balance;
  }

  get version(): number {
    return this.#version;
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAt);
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    return this.move(movement, LedgerDirection.Debit);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    return this.move(movement, LedgerDirection.Credit);
  }

  private move(movement: WalletMovement, direction: LedgerDirection): WalletLedgerEntry {
    if (!isRecord(movement) || !(movement.money instanceof Money) || !movement.money.isPositive()) {
      throw new WalletError('INVALID_MOVEMENT_AMOUNT');
    }
    const money = movement.money;
    if (this.currency !== money.currency) {
      throw new MoneyError('CURRENCY_MISMATCH');
    }
    if (direction === LedgerDirection.Debit && this.#balance.isLessThan(money)) {
      throw new WalletError('INSUFFICIENT_FUNDS');
    }

    const nextBalance =
      direction === LedgerDirection.Debit
        ? this.#balance.subtract(money)
        : this.#balance.add(money);
    const nextVersion = this.#version + 1;
    if (!isWalletVersion(nextVersion)) {
      throw new RangeError('Wallet version cannot be incremented safely');
    }

    // Build the complete entry before mutating the aggregate, including its metadata.
    const entry = WalletLedgerEntry.create({
      id: movement.ledgerEntryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      walletVersion: nextVersion,
      direction,
      money,
      balanceBefore: this.#balance,
      balanceAfter: nextBalance,
      createdAt: movement.at,
    });

    const nextUpdatedAt = entry.createdAt.getTime();
    this.#balance = nextBalance;
    this.#version = nextVersion;
    this.#updatedAt = nextUpdatedAt;
    return entry;
  }
}
