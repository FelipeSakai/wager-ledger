import type { SubmissionResult } from '../../application/transactions/submission-result';

const statuses = { PROCESSED: 200, PENDING_REFERENCE: 202, REJECTED: 422, FAILED: 500 } as const;
export function submissionHttpStatus(status: SubmissionResult['status']): 200 | 202 | 422 | 500 {
  return statuses[status];
}
