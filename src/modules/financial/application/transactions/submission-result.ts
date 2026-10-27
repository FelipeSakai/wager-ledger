import type { WagerResult, WagerState } from '../../domain/wagering/wager-state';
import { FinancialError } from '../financial-error';

export type SubmissionResult = WagerResult & { idempotentReplay: boolean; correlationId: string };
export function submissionResult(
  state: WagerState,
  replay: boolean,
  correlationId: string,
): SubmissionResult {
  if (!state.result) throw new FinancialError('INVALID_PERSISTED_TRANSACTION');
  return { ...structuredClone(state.result), idempotentReplay: replay, correlationId };
}
