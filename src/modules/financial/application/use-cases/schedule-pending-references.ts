import type { FinancialRuntime } from '../ports/financial-runtime';
import type { PendingReferenceStore, ReferenceCursor } from '../ports/pending-reference-store';
import type { ResumePendingTransaction } from './resume-pending-transaction';

export class SchedulePendingReferences {
  private stopped = false;
  private running = false;
  private cursor?: ReferenceCursor;
  constructor(
    private readonly store: PendingReferenceStore,
    private readonly resume: Pick<ResumePendingTransaction, 'execute'>,
    private readonly runtime: FinancialRuntime,
    private readonly batchSize = 50,
    private readonly concurrency = 5,
  ) {
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 50 ||
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 50
    )
      throw new RangeError('Invalid reference scheduler limits');
  }
  stop(): void {
    this.stopped = true;
  }
  async execute(): Promise<{ selected: number; completed: number; incomplete: number }> {
    const result = { selected: 0, completed: 0, incomplete: 0 };
    if (this.stopped || this.running) return result;
    this.running = true;
    try {
      const candidates = await this.store.due(this.runtime.now(), this.batchSize, this.cursor);
      // Advance even after errors so a permanently unreadable row cannot starve later wallets.
      // Restarting the worker only resets discovery; eligibility remains entirely durable.
      this.cursor = candidates.length === this.batchSize ? candidates.at(-1) : undefined;
      result.selected = candidates.length;
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(this.concurrency, candidates.length) }, async () => {
          while (!this.stopped) {
            const candidate = candidates[index++];
            if (!candidate) return;
            try {
              await this.resume.execute(candidate.id);
              result.completed++;
            } catch {
              result.incomplete++;
            }
          }
        }),
      );
      return result;
    } finally {
      this.running = false;
    }
  }
}
