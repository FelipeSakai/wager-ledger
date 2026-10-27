import type { FinancialOperationContext } from './financial-telemetry';
import type { FinancialPolicy } from '../financial-policy';
import type { FinancialPersistence } from './financial-persistence';

export interface FinancialUnitOfWork {
  run<T>(
    work: (persistence: FinancialPersistence) => Promise<T>,
    timeouts?: Pick<FinancialPolicy, 'lockTimeoutMilliseconds' | 'statementTimeoutMilliseconds'>,
    context?: FinancialOperationContext,
  ): Promise<T>;
}
