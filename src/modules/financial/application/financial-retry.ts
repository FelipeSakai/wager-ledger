import { operationTelemetry, type FinancialOperationContext } from './ports/financial-telemetry';
import { FinancialError, FinancialStorageError } from './financial-error';
import { defaultFinancialPolicy, type FinancialPolicy } from './financial-policy';
import type { FinancialRuntime } from './ports/financial-runtime';
import { report, silentTelemetry, type FinancialTelemetry } from './ports/financial-telemetry';

export async function financialRetry<T>(
  runtime: FinancialRuntime,
  action: () => Promise<T>,
  policy: FinancialPolicy = defaultFinancialPolicy,
  telemetry: FinancialTelemetry = silentTelemetry,
  context: FinancialOperationContext = {},
): Promise<T> {
  telemetry = operationTelemetry(telemetry, context);
  const start = runtime.monotonicMilliseconds();
  let collisions = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error: unknown) {
      if (!(error instanceof FinancialStorageError)) throw error;
      if (error.code === 'WALLET_NOT_FOUND') throw new FinancialError('WALLET_NOT_FOUND');
      // A unique collision waits for the winner's commit. Re-read only after rollback in a new context.
      if (runtime.monotonicMilliseconds() - start >= policy.retryBudgetMilliseconds)
        throw new FinancialError('INFRASTRUCTURE_UNAVAILABLE');
      if (
        ['IDENTITY_COLLISION', 'WALLET_COLLISION'].includes(error.code) &&
        collisions++ === 0 &&
        attempt < policy.maxAttempts
      ) {
        report(telemetry, { event: 'financial_retry', component: 'financial', cause: error.code });
        continue;
      }
      if (
        error.code === 'TRANSIENT' &&
        attempt < policy.maxAttempts &&
        runtime.monotonicMilliseconds() - start < policy.retryBudgetMilliseconds - 50
      ) {
        report(telemetry, { event: 'financial_retry', component: 'financial', cause: error.code });
        await runtime.sleep(10 + Math.floor(runtime.random() * 40));
        continue;
      }
      throw new FinancialError('INFRASTRUCTURE_UNAVAILABLE');
    }
  }
}
