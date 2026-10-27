import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setupSqsQueues } from '../../src/modules/financial/infrastructure/messaging/setup-sqs-queues';
import { sqsClient } from '../../src/platform/messaging/sqs-client';
import { financialTestDatabase } from '../support/financial-test-database';

for (const role of ['sqs', 'outbox', 'reference'] as const) {
  test.each(['normal', 'stalled', 'failed'] as const)(
    `real ${role} entrypoint keeps shutdown bounded through %s cleanup`,
    async (mode) => {
      const db = await financialTestDatabase();
      const client = sqsClient({
        endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
        local: true,
      });
      const suffix = randomUUID();
      let queues: Awaited<ReturnType<typeof setupSqsQueues>> | undefined;
      let child: ReturnType<typeof Bun.spawn> | undefined;
      const messages = new Map<string, unknown>();
      const waiting = new Map<string, (message: unknown) => void>();
      const wait = async (type: string) => {
        if (messages.has(type)) return messages.get(type);
        return Promise.race([
          new Promise((resolve) => waiting.set(type, resolve)),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`Missing worker message: ${type}`)),
              7000,
            );
            timer.unref();
          }),
        ]);
      };
      try {
        queues = await setupSqsQueues(
          client,
          `lifecycle-${suffix}.fifo`,
          `lifecycle-dlq-${suffix}.fifo`,
        );
        const key = role === 'reference' ? 'REFERENCE' : role.toUpperCase();
        child = Bun.spawn(
          [
            process.execPath,
            '--preload',
            resolve(__dirname, '../support/worker-cleanup-preload.ts'),
            resolve(__dirname, `../../src/bootstrap/${role}-worker.ts`),
          ],
          {
            env: {
              ...process.env,
              DATABASE_URL: db.url,
              SQS_QUEUE_NAME: `lifecycle-${suffix}.fifo`,
              SQS_DLQ_NAME: `lifecycle-dlq-${suffix}.fifo`,
              SQS_EVENTS_QUEUE_NAME: `lifecycle-${suffix}.fifo`,
              SQS_EVENTS_DLQ_NAME: `lifecycle-dlq-${suffix}.fifo`,
              SQS_OPERATIONS_PORT: '0',
              OUTBOX_OPERATIONS_PORT: '0',
              REFERENCE_OPERATIONS_PORT: '0',
              REFERENCE_POLL_MILLISECONDS: '10',
              [`${key}_SHUTDOWN_MILLISECONDS`]: mode !== 'normal' ? '2500' : '5000',
              WAGER_TEST_CLEANUP: mode,
            },
            stdout: 'ignore',
            stderr: 'ignore',
            timeout: 10000,
            ipc(message: unknown) {
              if (
                typeof message !== 'object' ||
                !message ||
                !('type' in message) ||
                typeof message.type !== 'string'
              )
                return;
              messages.set(message.type, message);
              waiting.get(message.type)?.(message);
              waiting.delete(message.type);
            },
          },
        );
        await wait('READY');
        const started = performance.now();
        child.kill('SIGTERM');
        await wait('CLEANUP_ENTERED');
        if (mode !== 'normal') child.kill('SIGTERM'); // Repeated signals must not reset the deadline.
        expect(await child.exited).toBe(mode !== 'normal' ? 1 : 0);
        if (mode !== 'normal') {
          expect(performance.now() - started).toBeGreaterThanOrEqual(2000);
          expect(performance.now() - started).toBeLessThan(6000);
        }
        const [row] = await db.observer.em.fork().execute<Record<string, unknown>[]>(`select
        (select count(*)::text from financial.wallets) as wallets,
        (select count(*)::text from financial.wallet_ledger_entries) as ledger`);
        expect(row).toEqual({ wallets: '0', ledger: '0' });
      } finally {
        if (child && child.exitCode === null) child.kill('SIGKILL');
        if (child) await child.exited;
        try {
          if (queues) {
            await client.send(new DeleteQueueCommand({ QueueUrl: queues.input }));
            await client.send(new DeleteQueueCommand({ QueueUrl: queues.dlq }));
          }
        } finally {
          client.destroy();
          await db.close();
        }
      }
    },
    20000,
  );
}
