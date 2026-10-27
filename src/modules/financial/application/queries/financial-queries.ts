import { isRecord, isUuid } from '../../domain/validation/domain-validation';
import type { Wallet } from '../../domain/wallet/wallet';
import { FinancialError, FinancialStorageError } from '../financial-error';
import type {
  FinancialReadStore,
  LedgerCursorPort,
  QueryDiagnostics,
} from '../ports/financial-read-store';

export class FinancialQueries {
  constructor(
    private readonly store: FinancialReadStore,
    private readonly cursor: LedgerCursorPort,
    private readonly diagnostics: QueryDiagnostics,
  ) {}

  wallet(id: string) {
    this.validateId(id);
    return this.read(() =>
      this.store.snapshot(async (snapshot) =>
        this.walletView(await this.requireWallet(await snapshot.wallet(id))),
      ),
    );
  }

  ledger(id: string, query: unknown) {
    this.validateId(id);
    if (!isRecord(query) || Object.keys(query).some((key) => !['limit', 'cursor'].includes(key)))
      throw new FinancialError('INVALID_QUERY_INPUT');
    const rawLimit = query.limit;
    if (
      rawLimit !== undefined &&
      (typeof rawLimit !== 'string' ||
        !/^[1-9][0-9]{0,2}$/.test(rawLimit) ||
        Number(rawLimit) > 100)
    )
      throw new FinancialError('INVALID_QUERY_INPUT');
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (
      query.cursor !== undefined &&
      (typeof query.cursor !== 'string' || query.cursor.length > 2048)
    )
      throw new FinancialError('INVALID_CURSOR');
    const cursor =
      query.cursor === undefined ? undefined : this.cursor.decode(query.cursor as string, id);
    return this.read(() =>
      this.store.snapshot(async (snapshot) => {
        const wallet = this.requireWallet(await snapshot.wallet(id));
        const upperVersion = cursor?.upperVersion ?? wallet.version;
        if (upperVersion > wallet.version) throw new FinancialError('INVALID_CURSOR');
        const entries = await snapshot.ledger(
          wallet.id,
          upperVersion,
          cursor?.lastVersion,
          limit + 1,
        );
        if (
          entries.some(
            (entry) => entry.money.currency !== wallet.currency || entry.walletId !== wallet.id,
          )
        )
          throw new FinancialError('INVALID_PERSISTED_DATA');
        const page = entries.slice(0, limit);
        const last = page.at(-1);
        return {
          items: page.map((entry) => ({
            id: entry.id,
            walletId: entry.walletId,
            transactionId: entry.transactionId,
            walletVersion: entry.walletVersion,
            direction: entry.direction,
            money: entry.money.toJSON(),
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            createdAt: entry.createdAt.toISOString(),
          })),
          ...(entries.length > limit && last
            ? {
                nextCursor: this.cursor.encode({
                  walletId: wallet.id,
                  upperVersion,
                  lastVersion: last.walletVersion,
                }),
              }
            : {}),
        };
      }),
    );
  }

  transaction(id: string) {
    this.validateId(id);
    return this.read(() =>
      this.store.snapshot(async (snapshot) => {
        const result = await snapshot.transaction(id);
        if (!result) throw new FinancialError('TRANSACTION_NOT_FOUND');
        return result;
      }),
    );
  }

  externalTransaction(providerId: string, externalId: string) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(providerId) ||
      externalId.length < 1 ||
      externalId.length > 128 ||
      externalId.trim() !== externalId
    ) {
      throw new FinancialError('INVALID_QUERY_INPUT');
    }
    return this.read(() =>
      this.store.snapshot(async (snapshot) => {
        const result = await snapshot.externalTransaction(providerId, externalId);
        if (!result) throw new FinancialError('TRANSACTION_NOT_FOUND');
        return result;
      }),
    );
  }

  reconcile(id: string, correlationId: string) {
    this.validateId(id);
    return this.read(() =>
      this.store.snapshot(async (snapshot) => {
        const wallet = this.requireWallet(await snapshot.wallet(id));
        const figures = await snapshot.reconciliation(wallet);
        if (!figures.consistent)
          this.diagnostics.reconciliationIssue(wallet.id, figures.issues, correlationId);
        return {
          walletId: wallet.id,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: { amount: figures.calculatedAmount, currency: wallet.currency },
          difference: { amount: figures.differenceAmount, currency: wallet.currency },
          consistent: figures.consistent,
          checkedEntries: figures.checkedEntries,
          ...(figures.issues.length ? { issues: figures.issues } : {}),
        };
      }),
    );
  }

  private validateId(id: string): void {
    if (!isUuid(id)) throw new FinancialError('INVALID_QUERY_INPUT');
  }
  private requireWallet(wallet: Wallet | null): Wallet {
    if (!wallet) throw new FinancialError('WALLET_NOT_FOUND');
    if (wallet.currency !== 'BRL') throw new FinancialError('INVALID_PERSISTED_DATA');
    return wallet;
  }
  private walletView(wallet: Wallet) {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }
  private async read<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (
        error instanceof FinancialStorageError &&
        ['TRANSIENT', 'UNAVAILABLE'].includes(error.code)
      )
        throw new FinancialError('INFRASTRUCTURE_UNAVAILABLE');
      throw error;
    }
  }
}
