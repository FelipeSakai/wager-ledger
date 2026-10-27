import type { FinancialOperationContext } from '../ports/financial-telemetry';
import { Money } from '../../domain/money/money';
import { isRecord, isUuid } from '../../domain/validation/domain-validation';
import { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { financialOutbox } from '../events/financial-outbox';
import { FinancialError } from '../financial-error';
import { financialPolicy, type FinancialPolicy } from '../financial-policy';
import { financialRetry } from '../financial-retry';
import type { FinancialRuntime } from '../ports/financial-runtime';
import { report, silentTelemetry, type FinancialTelemetry } from '../ports/financial-telemetry';
import type { FinancialUnitOfWork } from '../ports/financial-unit-of-work';
import type { FinancialTransactionWrite } from '../transactions/transaction-write';

export class OpenWallet {
  private readonly policy: FinancialPolicy;
  constructor(
    private readonly unit: FinancialUnitOfWork,
    private readonly runtime: FinancialRuntime,
    policy: Partial<FinancialPolicy> = {},
    private readonly telemetry: FinancialTelemetry = silentTelemetry,
  ) {
    this.policy = financialPolicy(policy);
  }

  async execute(input: unknown, correlationId?: string) {
    if (
      !isRecord(input) ||
      Object.keys(input).some((key) => !['playerId', 'initialBalance'].includes(key)) ||
      !isUuid(input.playerId) ||
      !isRecord(input.initialBalance) ||
      Object.keys(input.initialBalance).some((key) => !['amount', 'currency'].includes(key))
    )
      throw new FinancialError('INVALID_WALLET_INPUT');
    const playerId = input.playerId;
    const initialBalance = Money.from({
      amount: input.initialBalance.amount as string,
      currency: input.initialBalance.currency as string,
    });
    if (initialBalance.currency !== 'BRL') throw new FinancialError('UNSUPPORTED_WALLET_CURRENCY');
    const correlation = isUuid(correlationId) ? correlationId : this.runtime.newId();
    const context: FinancialOperationContext = { correlationId: correlation };
    let openingId: string | undefined;
    const result = await financialRetry(
      this.runtime,
      () =>
        this.unit.run(
          async (persistence) => {
            const existing = await persistence.findWallet(playerId, initialBalance.currency);
            if (existing)
              throw new FinancialError('WALLET_ALREADY_EXISTS', { walletId: existing.id });
            const at = this.runtime.now();
            const wallet = Wallet.open({ id: this.runtime.newId(), playerId, initialBalance, at });
            context.walletId = wallet.id;
            await persistence.insertWallet(wallet);
            if (initialBalance.isPositive()) {
              const id = this.runtime.newId();
              openingId = id;
              context.transactionId = id;
              const entry = WalletLedgerEntry.create({
                id: this.runtime.newId(),
                walletId: wallet.id,
                transactionId: id,
                walletVersion: 1,
                direction: LedgerDirection.Credit,
                money: initialBalance,
                balanceBefore: Money.zero(wallet.currency),
                balanceAfter: initialBalance,
                createdAt: at,
              });
              const transaction: FinancialTransactionWrite = {
                id,
                walletId: wallet.id,
                playerId: wallet.playerId,
                origin: 'INTERNAL',
                kind: 'OPENING',
                status: 'PROCESSED',
                internalIdentity: `opening:${wallet.id}`,
                money: initialBalance,
                result: {
                  transactionId: id,
                  status: 'PROCESSED',
                  balance: initialBalance.toJSON(),
                },
                createdAt: at,
                processedAt: at,
                completedAt: at,
              };
              await persistence.appendMovement(
                entry,
                transaction,
                financialOutbox(
                  transaction,
                  initialBalance.toJSON(),
                  correlation,
                  this.runtime,
                  entry,
                ),
              );
            }
            return {
              id: wallet.id,
              playerId: wallet.playerId,
              balance: wallet.balance.toJSON(),
              version: wallet.version,
            };
          },
          this.policy,
          context,
        ),
      this.policy,
      this.telemetry,
      context,
    );
    report(this.telemetry, {
      event: 'wallet_opened',
      walletId: result.id,
      correlationId: correlation,
    });
    if (openingId)
      report(this.telemetry, {
        event: 'transaction_transition',
        transactionId: openingId,
        walletId: result.id,
        correlationId: correlation,
        kind: 'OPENING',
        status: 'PROCESSED',
        transport: 'http',
      });
    return result;
  }
}
