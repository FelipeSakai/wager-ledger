import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createOrm } from '../../src/bootstrap/financial-database';
import type { InboxDelivery } from '../../src/modules/financial/application/ports/inbox';
import { OpenWallet } from '../../src/modules/financial/application/use-cases/open-wallet';
import { ProcessTransaction } from '../../src/modules/financial/application/use-cases/process-transaction';
import { MikroFinancialUnitOfWork } from '../../src/modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { systemFinancialRuntime as runtime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';
import { canonicalJson } from '../../src/modules/financial/presentation/sqs/transaction-envelope';
import { financialTestDatabase } from '../support/financial-test-database';
import { postgresCommitResponseProxy } from '../support/postgres-commit-response-proxy';

let db: Awaited<ReturnType<typeof financialTestDatabase>>;
beforeAll(async () => {
  db = await financialTestDatabase();
}, 30000);
afterAll(async () => {
  if (db) await db.close();
}, 30000);

test.each(['without-inbox', 'with-inbox'] as const)(
  'PROC-017: lost real COMMIT response recovers %s without another effect',
  async (transport) => {
    const unit = new MikroFinancialUnitOfWork(db.app);
    const wallet = await new OpenWallet(unit, runtime).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const command = {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const key = randomUUID();
    const messageId = randomUUID();
    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...command, idempotencyKey: key },
    };
    const body = canonicalJson(envelope);
    const delivery: InboxDelivery | undefined =
      transport === 'with-inbox'
        ? {
            id: randomUUID(),
            consumerName: 'commit-loss-test',
            messageId,
            payloadHash: runtime.sha256(body),
            body,
            sourceQueue: 'commit-loss-source',
            transportMessageId: randomUUID(),
            groupId: wallet.id,
            dlqQueue: 'commit-loss-dlq',
            receivedAt: new Date(),
          }
        : undefined;
    const proxy = await postgresCommitResponseProxy(db.url);
    let orm: Awaited<ReturnType<typeof createOrm>> | undefined;
    try {
      orm = await createOrm(proxy.url);
      proxy.arm();
      const uncertain = new ProcessTransaction(new MikroFinancialUnitOfWork(orm), runtime, [
        'provider-a',
      ]);
      await expect(uncertain.execute(command, key, undefined, delivery)).rejects.toMatchObject({
        code: 'INFRASTRUCTURE_UNAVAILABLE',
      });
      expect(proxy.droppedResponses).toBe(1);
      const sql = (query: string, params: unknown[] = []) =>
        db.observer.em.fork().execute<Record<string, unknown>[]>(query, params);
      const [committed] = await sql(
        'select id, status, result from financial.wager_transactions where idempotency_key=?',
        [key],
      );
      expect(committed).toMatchObject({
        status: 'PROCESSED',
        result: { balance: { amount: '75.00', currency: 'BRL' } },
      });
      const snapshot = () =>
        sql(
          `select
            (select count(*)::integer from financial.wager_transactions where wallet_id=?) as transactions,
            (select count(*)::integer from financial.wallet_ledger_entries where wallet_id=?) as ledger,
            (select count(*)::integer from financial.outbox_messages where aggregate_id=?) as events,
            (select count(*)::integer from financial.sqs_inbox where transaction_id=?) as inbox`,
          [wallet.id, wallet.id, wallet.id, committed!.id],
        );
      expect(await snapshot()).toEqual([
        { transactions: 2, ledger: 2, events: 4, inbox: delivery ? 1 : 0 },
      ]);
      const normal = new ProcessTransaction(new MikroFinancialUnitOfWork(orm), runtime, [
        'provider-a',
      ]);
      const replay = await normal.execute(command, key, undefined, delivery);
      expect(replay).toMatchObject({
        transactionId: committed!.id,
        status: 'PROCESSED',
        balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: true,
      });
      expect(await snapshot()).toEqual([
        { transactions: 2, ledger: 2, events: 4, inbox: delivery ? 1 : 0 },
      ]);
      await normal.execute(
        {
          ...command,
          externalTransactionId: randomUUID(),
          kind: 'WIN',
          money: { amount: '10.00', currency: 'BRL' },
        },
        randomUUID(),
      );
      expect(await normal.execute(command, key, undefined, delivery)).toMatchObject({
        transactionId: committed!.id,
        balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: true,
      });
      const [balance] = await sql(
        `select w.balance::text as amount, w.version,
          w.balance=coalesce(sum(case when l.direction='CREDIT' then l.amount else -l.amount end),0) as reconciled
          from financial.wallets w left join financial.wallet_ledger_entries l on l.wallet_id=w.id
          where w.id=? group by w.id`,
        [wallet.id],
      );
      expect(balance).toEqual({ amount: '85.00', version: '3', reconciled: true });
    } finally {
      if (orm) await orm.close(true);
      await proxy.close();
    }
  },
  30000,
);
