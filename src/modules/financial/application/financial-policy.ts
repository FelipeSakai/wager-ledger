export interface FinancialPolicy {
  readonly maxAttempts: number;
  readonly retryBudgetMilliseconds: number;
  readonly lockTimeoutMilliseconds: number;
  readonly statementTimeoutMilliseconds: number;
  readonly referenceWaitMilliseconds: number;
  readonly referenceMaxAttempts: number;
  readonly referenceBaseDelayMilliseconds: number;
  readonly referenceMaxDelayMilliseconds: number;
}
export function financialPolicy(overrides: Partial<FinancialPolicy> = {}): FinancialPolicy {
  const policy: FinancialPolicy = {
    maxAttempts: 3,
    retryBudgetMilliseconds: 3000,
    lockTimeoutMilliseconds: 250,
    statementTimeoutMilliseconds: 2000,
    referenceWaitMilliseconds: 24 * 60 * 60 * 1000,
    referenceMaxAttempts: 1000,
    referenceBaseDelayMilliseconds: 5000,
    referenceMaxDelayMilliseconds: 300000,
    ...overrides,
  };
  if (
    Object.values(policy).some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    policy.referenceMaxDelayMilliseconds < policy.referenceBaseDelayMilliseconds
  ) {
    throw new RangeError('Financial policy limits must be positive safe integers');
  }
  return Object.freeze(policy);
}
export const defaultFinancialPolicy = financialPolicy();
