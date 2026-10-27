import { createHash, randomUUID } from 'node:crypto';
import type { FinancialRuntime } from '../../application/ports/financial-runtime';

export const systemFinancialRuntime: FinancialRuntime = {
  newId: randomUUID,
  now: () => new Date(),
  monotonicMilliseconds: () => performance.now(),
  sha256: (value) => createHash('sha256').update(value, 'utf8').digest('hex'),
  random: Math.random,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};
