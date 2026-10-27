import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { DependencyProbes } from '../../../../platform/observability/operational-contracts';
export interface ObservedQueue {
  name: string;
  dlq: boolean;
}
export class LocalDependencyProbes implements DependencyProbes {
  readonly sqs?: (signal: AbortSignal) => Promise<{ sqs_dlq_messages: number }>;
  constructor(
    private readonly orm: MikroORM,
    client?: SQSClient,
    queues: readonly ObservedQueue[] = [],
  ) {
    if (client && queues.length)
      this.sqs = async (signal) => {
        const results = await Promise.all(
          queues.map(async (queue) => {
            const result = await client.send(new GetQueueUrlCommand({ QueueName: queue.name }), {
              abortSignal: signal,
            });
            if (!result.QueueUrl) throw new Error('Queue not reachable');
            const attributes = await client.send(
              new GetQueueAttributesCommand({
                QueueUrl: result.QueueUrl,
                AttributeNames: [
                  'ApproximateNumberOfMessages',
                  'ApproximateNumberOfMessagesNotVisible',
                  'ApproximateNumberOfMessagesDelayed',
                ],
              }),
              { abortSignal: signal },
            );
            if (!queue.dlq) return 0;
            const counts = (
              [
                'ApproximateNumberOfMessages',
                'ApproximateNumberOfMessagesNotVisible',
                'ApproximateNumberOfMessagesDelayed',
              ] as const
            ).map((key) => Number(attributes.Attributes?.[key]));
            if (counts.some((value) => !Number.isSafeInteger(value) || value < 0))
              throw new Error('Queue count unavailable');
            return counts.reduce((total, count) => total + count, 0);
          }),
        );
        return { sqs_dlq_messages: results.reduce((total, count) => total + count, 0) };
      };
  }
  private async read<T>(query: string, signal: AbortSignal): Promise<T[]> {
    signal.throwIfAborted();
    const context = this.orm.em.fork();
    try {
      return await context
        .getConnection()
        .getClient()
        .transaction()
        .setAccessMode('read only')
        .execute(async (transaction) => {
          context.setTransactionContext(transaction);
          signal.throwIfAborted();
          await context.execute(
            "select set_config('statement_timeout','1000ms',true),set_config('lock_timeout','250ms',true)",
          );
          return context.execute<T[]>(query);
        });
    } finally {
      context.resetTransactionContext();
    }
  }
  async postgres(signal: AbortSignal): Promise<void> {
    await this.read(
      `select 1 as reachable from financial.wallets,financial.wager_transactions,financial.wallet_ledger_entries,financial.outbox_messages,financial.sqs_inbox,financial.sqs_origins,financial.dlq_transfers,financial.failure_diagnostics limit 0`,
      signal,
    );
  }
  async backlog(signal: AbortSignal): Promise<Record<string, number>> {
    const [row] = await this.read<Record<string, unknown>>(
      `select
      (select count(*) from financial.outbox_messages where published_at is null)::text as outbox_pending,
      (select coalesce(greatest(0,extract(epoch from clock_timestamp()-min(occurred_at))),0) from financial.outbox_messages where published_at is null)::text as outbox_lag_seconds,
      (select count(*) from financial.dlq_transfers where dlq_confirmed_at is null)::text as dlq_transfer_pending,
      (select coalesce(greatest(0,extract(epoch from clock_timestamp()-min(created_at))),0) from financial.dlq_transfers where dlq_confirmed_at is null)::text as dlq_transfer_lag_seconds,
      (select count(*) from financial.wager_transactions where status='PENDING_REFERENCE')::text as pending_references`,
      signal,
    );
    if (!row) throw new Error('Backlog unavailable');
    const result = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Number(value)]),
    );
    if (Object.values(result).some((value) => !Number.isFinite(value) || value < 0))
      throw new Error('Backlog unavailable');
    return result;
  }
}
