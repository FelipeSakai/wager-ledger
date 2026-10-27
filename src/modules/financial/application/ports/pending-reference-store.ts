export interface ReferenceCursor {
  nextAttemptAt: string;
  id: string;
}
export interface PendingReferenceStore {
  // Candidate discovery takes no financial locks; ResumePendingTransaction rechecks eligibility.
  due(at: Date, limit: number, after?: ReferenceCursor): Promise<ReferenceCursor[]>;
  failures(transactionId?: string): Promise<Readonly<Record<string, unknown>>[]>;
}
