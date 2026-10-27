import type { MikroORM } from '@mikro-orm/postgresql';
import type {
  PendingReferenceStore,
  ReferenceCursor,
} from '../../application/ports/pending-reference-store';
import { isUuid } from '../../domain/validation/domain-validation';

export class MikroPendingReferenceStore implements PendingReferenceStore {
  constructor(private readonly orm: MikroORM) {}
  async due(at: Date, limit: number, after?: ReferenceCursor): Promise<ReferenceCursor[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isFinite(at.getTime()))
      throw new RangeError('Invalid reference scan');
    const rows = await this.orm.em.fork().execute<{ id: string; next_attempt_at: string }[]>(
      `select id, to_char(next_reference_attempt_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as next_attempt_at
      from financial.wager_transactions where status='PENDING_REFERENCE' and next_reference_attempt_at<=?
      ${after ? 'and (next_reference_attempt_at,id)>(?::timestamptz,?::uuid)' : ''}
      order by next_reference_attempt_at,id limit ?`,
      [at, ...(after ? [after.nextAttemptAt, after.id] : []), limit],
    );
    return rows.map((row) => ({ id: row.id, nextAttemptAt: row.next_attempt_at }));
  }
  async failures(transactionId?: string): Promise<Readonly<Record<string, unknown>>[]> {
    if (transactionId !== undefined && !isUuid(transactionId))
      throw new RangeError('Invalid transaction ID');
    return this.orm.em.fork().execute(
      `select transaction_id, failure_code, correlation_id, failed_at
      from financial.failure_diagnostics ${transactionId ? 'where transaction_id=?' : ''}
      order by failed_at,transaction_id limit 100`,
      transactionId ? [transactionId] : [],
    );
  }
}
