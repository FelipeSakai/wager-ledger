import { Money } from '../money/money';
import { MoneyError } from '../money/money-error';
import { isRecord, isTimestamp, isUuid } from '../validation/domain-validation';
import type { Wallet } from '../wallet/wallet';
import { WalletError } from '../wallet/wallet-error';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';

import type { PendingReason, WagerState } from './wager-state';
import { WagerTransactionError } from './wager-transaction-error';

export class WagerTransaction {
  #state: WagerState;
  private constructor(state: WagerState) {
    this.#state = WagerTransaction.copy(state);
    Object.freeze(this);
  }

  static create(
    input: Pick<
      WagerState,
      'id' | 'command' | 'idempotencyKey' | 'payloadHash' | 'payloadHashVersion' | 'createdAt'
    >,
  ): WagerTransaction {
    const state: WagerState = { ...input, status: 'PENDING', referenceAttempts: 0 };
    WagerTransaction.validate(state, false);
    return new WagerTransaction(state);
  }
  static rehydrate(state: WagerState): WagerTransaction {
    try {
      WagerTransaction.validate(state, true);
      return new WagerTransaction(state);
    } catch (error: unknown) {
      if (error instanceof WagerTransactionError || error instanceof MoneyError)
        throw new WagerTransactionError('INVALID_PERSISTED_TRANSACTION');
      throw error;
    }
  }
  snapshot(): WagerState {
    return WagerTransaction.copy(this.#state);
  }

  apply(
    wallet: Wallet,
    options: {
      at: Date;
      ledgerEntryId: string;
      reference?: WagerState;
      alreadyReversed: boolean;
      nextReferenceAttemptAt: Date;
      referenceExpiresAt: Date;
      maxReferenceAttempts?: number;
    },
  ): WalletLedgerEntry | undefined {
    const state = this.#state;
    if (
      !['PENDING', 'PENDING_REFERENCE'].includes(state.status) ||
      !isTimestamp(options.at) ||
      wallet.id.toLowerCase() !== state.command.walletId.toLowerCase()
    )
      throw new WagerTransactionError('INVALID_TRANSACTION_TRANSITION');
    const command = state.command;
    const reject = (code: string): undefined => {
      this.complete('REJECTED', wallet, options.at, code);
      return undefined;
    };
    if (wallet.playerId.toLowerCase() !== command.playerId.toLowerCase())
      return reject('WALLET_PLAYER_MISMATCH');
    if (wallet.currency !== command.money.currency) return reject('CURRENCY_MISMATCH');
    if (command.kind === 'LOSS' ? !command.money.isZero() : !command.money.isPositive())
      return reject('INVALID_OPERATION_AMOUNT');
    const ref = options.reference;
    if (command.referenceExternalTransactionId !== undefined) {
      if (command.referenceExternalTransactionId === command.externalTransactionId)
        return reject('REFERENCE_SELF_REFERENCE');
      if (ref) {
        const other = ref.command;
        if (
          other.providerId !== command.providerId ||
          other.externalTransactionId !== command.referenceExternalTransactionId ||
          other.playerId.toLowerCase() !== command.playerId.toLowerCase() ||
          other.walletId.toLowerCase() !== command.walletId.toLowerCase() ||
          other.money.currency !== command.money.currency ||
          other.roundId !== command.roundId
        )
          return reject('REFERENCE_CONTEXT_MISMATCH');
        const allowed = command.kind === 'ROLLBACK' ? ['BET', 'WIN', 'REFUND'] : ['BET'];
        if (!allowed.includes(other.kind)) return reject('REFERENCE_KIND_NOT_ALLOWED');
        if (ref.status === 'REJECTED' || ref.status === 'FAILED')
          return reject('REFERENCE_NOT_PROCESSED');
        if (['REFUND', 'ROLLBACK'].includes(command.kind) && !command.money.equals(other.money))
          return reject('REFERENCE_AMOUNT_MISMATCH');
      }
      if (!ref || ref.status !== 'PROCESSED') {
        const reason: PendingReason = ref ? 'REFERENCE_NOT_READY' : 'REFERENCE_NOT_FOUND';
        const expiresAt = state.referenceExpiresAt ?? options.referenceExpiresAt;
        if (
          state.status === 'PENDING_REFERENCE' &&
          (options.at >= expiresAt ||
            state.referenceAttempts >= (options.maxReferenceAttempts ?? 1000))
        ) {
          return reject(ref ? 'REFERENCE_NOT_READY_EXPIRED' : 'REFERENCE_NOT_FOUND_EXPIRED');
        }
        if (!isTimestamp(options.nextReferenceAttemptAt) || !isTimestamp(expiresAt))
          throw new WagerTransactionError('INVALID_TRANSACTION_STATE');
        state.status = 'PENDING_REFERENCE';
        state.referenceAttempts += 1;
        state.pendingReason = reason;
        state.nextReferenceAttemptAt = new Date(options.nextReferenceAttemptAt);
        state.referenceExpiresAt = new Date(expiresAt);
        state.result = {
          transactionId: state.id,
          status: 'PENDING_REFERENCE',
          balance: wallet.balance.toJSON(),
        };
        return undefined;
      }
      state.referenceTransactionId = ref.id;
      if (['REFUND', 'ROLLBACK'].includes(command.kind) && options.alreadyReversed)
        return reject('REFERENCE_ALREADY_REVERSED');
    }
    let entry: WalletLedgerEntry | undefined;
    try {
      if (command.kind !== 'LOSS') {
        const debit =
          command.kind === 'BET' ||
          (command.kind === 'ROLLBACK' && ['WIN', 'REFUND'].includes(ref!.command.kind));
        entry = wallet[debit ? 'debit' : 'credit']({
          ledgerEntryId: options.ledgerEntryId,
          transactionId: state.id,
          money: command.money,
          at: options.at,
        });
      }
    } catch (error: unknown) {
      if (error instanceof WalletError && error.code === 'INSUFFICIENT_FUNDS') {
        return reject(
          command.kind === 'BET' ? 'INSUFFICIENT_FUNDS' : 'REVERSAL_INSUFFICIENT_FUNDS',
        );
      }
      if (error instanceof MoneyError && error.code === 'MONEY_OUT_OF_RANGE')
        return reject('MONEY_OUT_OF_RANGE');
      throw error;
    }
    this.complete('PROCESSED', wallet, options.at);
    return entry;
  }

  failReference(wallet: Wallet, at: Date): void {
    if (
      this.#state.status !== 'PENDING_REFERENCE' ||
      !isTimestamp(at) ||
      wallet.id.toLowerCase() !== this.#state.command.walletId.toLowerCase() ||
      wallet.playerId.toLowerCase() !== this.#state.command.playerId.toLowerCase() ||
      wallet.currency !== this.#state.command.money.currency
    )
      throw new WagerTransactionError('INVALID_TRANSACTION_TRANSITION');
    this.#state.status = 'FAILED';
    this.#state.result = {
      transactionId: this.#state.id,
      status: 'FAILED',
      failureCode: 'INVALID_REFERENCE_STATE',
      balance: wallet.balance.toJSON(),
    };
    this.#state.completedAt = new Date(at);
    this.#state.nextReferenceAttemptAt = undefined;
  }

  private complete(
    status: 'PROCESSED' | 'REJECTED',
    wallet: Wallet,
    at: Date,
    failureCode?: string,
  ): void {
    this.#state.status = status;
    this.#state.result = {
      transactionId: this.#state.id,
      status,
      balance: wallet.balance.toJSON(),
      ...(failureCode ? { failureCode } : {}),
    };
    this.#state.completedAt = new Date(at);
    this.#state.processedAt = status === 'PROCESSED' ? new Date(at) : undefined;
    this.#state.nextReferenceAttemptAt = undefined;
  }
  private static copy(state: WagerState): WagerState {
    return {
      ...state,
      command: { ...state.command },
      result: state.result ? structuredClone(state.result) : undefined,
      createdAt: new Date(state.createdAt),
      processedAt: state.processedAt && new Date(state.processedAt),
      completedAt: state.completedAt && new Date(state.completedAt),
      nextReferenceAttemptAt:
        state.nextReferenceAttemptAt && new Date(state.nextReferenceAttemptAt),
      referenceExpiresAt: state.referenceExpiresAt && new Date(state.referenceExpiresAt),
    };
  }
  private static validate(state: WagerState, persisted: boolean): void {
    const invalid = () => {
      throw new WagerTransactionError('INVALID_TRANSACTION_STATE');
    };
    if (!isRecord(state) || !isRecord(state.command)) return invalid();
    const c = state.command;
    if (
      !isUuid(state.id) ||
      !isRecord(c) ||
      !isUuid(c.walletId) ||
      !isUuid(c.playerId) ||
      !(c.money instanceof Money) ||
      c.money.isNegative() ||
      !['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(c.kind) ||
      ![c.providerId, c.externalTransactionId, c.roundId, c.gameId, state.idempotencyKey].every(
        (v) => typeof v === 'string' && v.length > 0 && v.trim() === v,
      ) ||
      !/^[0-9a-f]{64}$/.test(state.payloadHash) ||
      state.payloadHashVersion !== 1 ||
      !isTimestamp(state.createdAt) ||
      !Number.isSafeInteger(state.referenceAttempts) ||
      state.referenceAttempts < 0 ||
      !['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'].includes(state.status)
    )
      invalid();
    if (
      (['REFUND', 'ROLLBACK'].includes(c.kind) && c.referenceExternalTransactionId === undefined) ||
      (c.kind === 'BET' && c.referenceExternalTransactionId !== undefined) ||
      (c.referenceExternalTransactionId !== undefined &&
        (typeof c.referenceExternalTransactionId !== 'string' ||
          !c.referenceExternalTransactionId ||
          c.referenceExternalTransactionId.trim() !== c.referenceExternalTransactionId))
    )
      invalid();
    if (state.referenceTransactionId !== undefined && !isUuid(state.referenceTransactionId))
      invalid();
    if (state.status === 'PENDING') {
      if (
        persisted ||
        state.result ||
        state.processedAt ||
        state.completedAt ||
        state.referenceAttempts !== 0
      )
        invalid();
    } else {
      const r = state.result;
      if (!r || r.transactionId !== state.id || r.status !== state.status) return invalid();
      const balance = Money.rehydrate(r.balance);
      if (balance.isNegative()) invalid();
      // These early rejections capture the wallet's balance before command context matches.
      const playerMismatch =
        state.status === 'REJECTED' && r.failureCode === 'WALLET_PLAYER_MISMATCH';
      const currencyMismatch = state.status === 'REJECTED' && r.failureCode === 'CURRENCY_MISMATCH';
      if (
        !playerMismatch &&
        (currencyMismatch
          ? balance.currency === c.money.currency
          : balance.currency !== c.money.currency)
      )
        invalid();
      if (
        state.status === 'REJECTED' || state.status === 'FAILED'
          ? typeof r.failureCode !== 'string' || !r.failureCode
          : r.failureCode !== undefined
      )
        invalid();
      if (state.status === 'PENDING_REFERENCE') {
        if (
          !isTimestamp(state.nextReferenceAttemptAt) ||
          !isTimestamp(state.referenceExpiresAt) ||
          !['REFERENCE_NOT_FOUND', 'REFERENCE_NOT_READY'].includes(state.pendingReason ?? '') ||
          state.completedAt ||
          state.processedAt ||
          state.referenceAttempts < 1
        )
          invalid();
      } else if (!isTimestamp(state.completedAt) || state.nextReferenceAttemptAt !== undefined)
        invalid();
      if (
        (state.status === 'PROCESSED') !== (state.processedAt !== undefined) ||
        (state.processedAt !== undefined && !isTimestamp(state.processedAt))
      )
        invalid();
    }
  }
}
