import { createHash, randomUUID } from 'node:crypto';
import { createOrm } from '../../src/bootstrap/financial-database';
import type { FinancialTransactionWrite } from '../../src/modules/financial/application/transactions/transaction-write';
import { WalletError } from '../../src/modules/financial/domain/wallet/wallet-error';
import { MikroFinancialUnitOfWork } from '../../src/modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { at, eventsFor, money, move, processedTransaction } from './financial-fixtures';

function command(type: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = (message: unknown): void => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === type
      ) {
        process.off('message', listener);
        resolve();
      }
    };
    process.on('message', listener);
  });
}

async function main(): Promise<void> {
  const [walletId, amount, mode] = process.argv.slice(2);
  const url = process.env.WAGER_TEST_DATABASE_URL;
  if (!walletId || !amount || !url || !process.send)
    throw new Error('Race worker requires its test harness');
  const start = command('START');
  const orm = await createOrm(url);
  try {
    process.send({ type: 'READY', pid: process.pid });
    await start;
    let status = 'PROCESSED';
    await new MikroFinancialUnitOfWork(orm).run(async (tx) => {
      const wallet = await tx.lockWallet(walletId);
      if (mode === 'hold') {
        const release = command('RELEASE');
        process.send?.({ type: 'LOCKED', pid: process.pid });
        await release;
      }
      try {
        const entry = move(wallet, 'debit', amount);
        const transaction = processedTransaction(wallet, entry, 'BET');
        await tx.appendMovement(entry, transaction, eventsFor(transaction, entry));
      } catch (error: unknown) {
        if (!(error instanceof WalletError) || error.code !== 'INSUFFICIENT_FUNDS') throw error;
        status = 'REJECTED';
        const id = randomUUID();
        const transaction: FinancialTransactionWrite = {
          id,
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: money(amount),
          origin: 'PROVIDER',
          kind: 'BET',
          status: 'REJECTED',
          providerId: 'provider-a',
          externalTransactionId: id,
          idempotencyKey: `provider-a:${id}`,
          payloadHash: createHash('sha256').update(id).digest('hex'),
          roundId: 'round-1',
          gameId: 'game-1',
          failureCode: 'INSUFFICIENT_FUNDS',
          result: {
            transactionId: id,
            status: 'REJECTED',
            failureCode: 'INSUFFICIENT_FUNDS',
            balance: wallet.balance.toJSON(),
          },
          createdAt: at(),
          completedAt: at(),
        };
        await tx.recordTransaction(transaction, eventsFor(transaction));
      }
    });
    process.send({ type: 'DONE', pid: process.pid, status });
  } finally {
    await orm.close(true);
    process.disconnect?.();
  }
}

main().catch((error: unknown) => {
  process.send?.({
    type: 'ERROR',
    name: error instanceof Error ? error.name : 'UnknownError',
    code: typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
  });
  process.disconnect?.();
  process.exitCode = 1;
});
