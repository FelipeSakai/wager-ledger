import { ProcessShutdown, closeResources } from '../platform/process/shutdown';
import { ResumePendingTransaction } from '../modules/financial/application/use-cases/resume-pending-transaction';
import { SchedulePendingReferences } from '../modules/financial/application/use-cases/schedule-pending-references';
import { OperationalTelemetry } from '../modules/financial/infrastructure/observability/operational-telemetry';
import { MikroFinancialUnitOfWork } from '../modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { MikroPendingReferenceStore } from '../modules/financial/infrastructure/references/mikro-pending-reference-store';
import { systemFinancialRuntime as runtime } from '../modules/financial/infrastructure/runtime/system-financial-runtime';
import { createOrm } from './financial-database';
import { workerOperations } from './worker-operations';

const processTelemetry = new OperationalTelemetry('references');
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const poll = Number(process.env.REFERENCE_POLL_MILLISECONDS ?? '1000');
  const shutdownMilliseconds = Number(process.env.REFERENCE_SHUTDOWN_MILLISECONDS ?? '30000');
  if (![poll, shutdownMilliseconds].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new RangeError('Invalid reference worker timing');
  const orm = await createOrm(process.env.DATABASE_URL);
  let operations: Awaited<ReturnType<typeof workerOperations>> | undefined;
  let shutdown: ProcessShutdown | undefined;
  try {
    operations = await workerOperations('references', orm, undefined, [], processTelemetry);
    const telemetry = operations.telemetry;
    const scheduler = new SchedulePendingReferences(
      new MikroPendingReferenceStore(orm),
      new ResumePendingTransaction(
        new MikroFinancialUnitOfWork(orm, telemetry),
        runtime,
        {},
        telemetry,
      ),
      runtime,
      Number(process.env.REFERENCE_BATCH_SIZE ?? '50'),
      Number(process.env.REFERENCE_CONCURRENCY ?? '5'),
    );
    let stopped = false;
    shutdown = new ProcessShutdown(shutdownMilliseconds, () => {
      operations!.service.stop();
      stopped = true;
      scheduler.stop();
    });
    operations.service.start();
    while (!stopped) {
      try {
        const result = await scheduler.execute();
        if (result.selected > 0)
          telemetry.observe({
            event: 'reference_scan',
            outcome: result.incomplete ? 'failure' : 'success',
          });
      } catch {
        telemetry.observe({
          event: 'worker_poll_failed',
          component: 'references',
          outcome: 'failure',
        });
      }
      if (!stopped) await runtime.sleep(poll);
    }
  } finally {
    try {
      await closeResources([
        async () => {
          if (operations) await operations.close();
        },
        () => orm.close(true),
      ]);
    } catch (error: unknown) {
      shutdown?.request();
      throw error;
    }
    shutdown?.complete();
  }
}
main().catch(() => {
  processTelemetry.observe({
    event: 'worker_poll_failed',
    component: 'references',
    outcome: 'failure',
    cause: 'internal',
  });
  process.exitCode = 1;
});
