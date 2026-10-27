import { createOrm } from '../../src/bootstrap/financial-database';
import { ProcessTransaction } from '../../src/modules/financial/application/use-cases/process-transaction';
import { MikroFinancialUnitOfWork } from '../../src/modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { systemFinancialRuntime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';

async function main(): Promise<void> {
  const url = process.env.WAGER_TEST_DATABASE_URL;
  if (!url || !process.send) throw new Error('Race worker requires its harness');
  const start = new Promise<{ input: unknown; key: string; count: number }>((resolve) => {
    process.once('message', (message: unknown) =>
      resolve(message as { input: unknown; key: string; count: number }),
    );
  });
  const orm = await createOrm(url);
  try {
    const processor = new ProcessTransaction(
      new MikroFinancialUnitOfWork(orm),
      systemFinancialRuntime,
      ['provider-a', 'provider-b'],
    );
    process.send({ type: 'READY', pid: process.pid });
    const { input, key, count } = await start;
    const results = await Promise.all(
      Array.from({ length: count }, () => processor.execute(input, key)),
    );
    process.send({ type: 'DONE', pid: process.pid, results });
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
