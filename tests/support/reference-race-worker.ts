import { createOrm } from '../../src/bootstrap/financial-database';
import { RolledBackFinancialFailure } from '../../src/modules/financial/application/financial-error';
import type { FinancialUnitOfWork } from '../../src/modules/financial/application/ports/financial-unit-of-work';
import { ResumePendingTransaction } from '../../src/modules/financial/application/use-cases/resume-pending-transaction';
import { SchedulePendingReferences } from '../../src/modules/financial/application/use-cases/schedule-pending-references';
import { MikroFinancialUnitOfWork } from '../../src/modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { MikroPendingReferenceStore } from '../../src/modules/financial/infrastructure/references/mikro-pending-reference-store';
import { systemFinancialRuntime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';
function command(type: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = (value: unknown) => {
      if (typeof value === 'object' && value !== null && 'type' in value && value.type === type) {
        process.off('message', listener);
        resolve();
      }
    };
    process.on('message', listener);
  });
}
async function main(): Promise<void> {
  if (!process.env.WAGER_TEST_DATABASE_URL || !process.send)
    throw new Error('Reference worker requires harness');
  const start = command('START');
  const release = command('RELEASE');
  const orm = await createOrm(process.env.WAGER_TEST_DATABASE_URL);
  const base = new MikroFinancialUnitOfWork(orm);
  const runtime = {
    ...systemFinancialRuntime,
    now: () => new Date(process.env.REFERENCE_TEST_TIME!),
    random: () => 0,
  };
  const mode = process.env.REFERENCE_TEST_MODE;
  let held = false;
  const unit: FinancialUnitOfWork = {
    run: async (work, timeouts) => {
      try {
        const result = await base.run(
          (p) =>
            work(
              new Proxy(p, {
                get(target, property) {
                  const value = Reflect.get(target, property);
                  if (typeof value !== 'function') return value;
                  return async (...args: unknown[]) => {
                    const result: unknown = await value.apply(target, args);
                    if (
                      !held &&
                      ['recordTransaction', 'appendMovement'].includes(String(property)) &&
                      mode === 'before-commit'
                    ) {
                      held = true;
                      process.send?.({ type: 'FLUSHED', pid: process.pid });
                      await release;
                    }
                    return result;
                  };
                },
              }),
            ),
          timeouts,
        );
        if (!held && mode === 'after-commit') {
          held = true;
          process.send?.({ type: 'COMMITTED', pid: process.pid });
          await release;
        }
        return result;
      } catch (error: unknown) {
        if (!held && mode === 'after-rollback' && error instanceof RolledBackFinancialFailure) {
          held = true;
          process.send?.({ type: 'ROLLED_BACK', pid: process.pid });
          await release;
        }
        throw error;
      }
    },
  };
  try {
    const scheduler = new SchedulePendingReferences(
      new MikroPendingReferenceStore(orm),
      new ResumePendingTransaction(unit, runtime, {
        lockTimeoutMilliseconds: 5000,
        statementTimeoutMilliseconds: 7000,
      }),
      runtime,
      50,
      5,
    );
    process.once('SIGTERM', () => scheduler.stop());
    process.send({ type: 'READY', pid: process.pid });
    await start;
    const result = await scheduler.execute();
    process.send({ type: 'DONE', pid: process.pid, ...result });
  } finally {
    await orm.close(true);
    process.disconnect?.();
  }
}
main().catch((error: unknown) => {
  process.send?.({ type: 'ERROR', name: error instanceof Error ? error.name : 'UnknownError' });
  process.disconnect?.();
  process.exitCode = 1;
});
