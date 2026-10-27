import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type {
  FinancialOutboxStore,
  OutboxClaim,
  OutboxFailureCode,
  OutboxInspection,
} from '../../application/ports/financial-outbox-store';
import { isUuid } from '../../domain/validation/domain-validation';

export class MikroFinancialOutboxStore implements FinancialOutboxStore {
  constructor(private readonly orm: MikroORM) {}

  private shortTransaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(async (em) => {
      await em.execute(
        "select set_config('statement_timeout','2000ms',true),set_config('lock_timeout','250ms',true)",
      );
      return work(em);
    });
  }

  async claim(limit: number, leaseMilliseconds: number): Promise<OutboxClaim[]> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10 ||
      !Number.isSafeInteger(leaseMilliseconds) ||
      leaseMilliseconds < 1
    )
      throw new RangeError('Invalid outbox claim limits');
    const rows = await this.shortTransaction((em) =>
      em.execute<Record<string, unknown>[]>(
        `with candidates as (
      select id from financial.outbox_messages where published_at is null and suspended_at is null
        and (next_attempt_at is null or next_attempt_at<=clock_timestamp())
        and (lease_until is null or lease_until<=clock_timestamp())
      order by occurred_at,id for update skip locked limit ?)
      update financial.outbox_messages o set claim_token=gen_random_uuid(),
        lease_until=clock_timestamp()+(?::text||' milliseconds')::interval
      from candidates c where o.id=c.id returning o.*`,
        [limit, leaseMilliseconds],
      ),
    );
    return rows.map((row) => ({
      id: row.id as string,
      transactionId: row.transaction_id as string,
      aggregateId: row.aggregate_id as string,
      eventType: row.event_type as string,
      eventVersion: row.event_version as number,
      payload: row.payload,
      occurredAt: String(row.occurred_at),
      claimToken: row.claim_token as string,
      attempts: row.attempts as number,
    }));
  }

  async renew(id: string, token: string, leaseMilliseconds: number): Promise<boolean> {
    const rows = await this.shortTransaction((em) =>
      em.execute(
        `update financial.outbox_messages
      set lease_until=clock_timestamp()+(?::text||' milliseconds')::interval
      where id=? and claim_token=? and lease_until>clock_timestamp() and published_at is null and suspended_at is null returning id`,
        [leaseMilliseconds, id, token],
      ),
    );
    return rows.length === 1;
  }

  async confirm(id: string, token: string): Promise<boolean> {
    const rows = await this.shortTransaction((em) =>
      em.execute(
        `update financial.outbox_messages
      set published_at=clock_timestamp(),claim_token=null,lease_until=null,last_error_code=null
      where id=? and claim_token=? and lease_until>clock_timestamp() and published_at is null and suspended_at is null returning id`,
        [id, token],
      ),
    );
    return rows.length === 1;
  }

  async fail(id: string, token: string, delayMilliseconds: number, maxAttempts: number) {
    const [row] = await this.shortTransaction((em) =>
      em.execute<Record<string, unknown>[]>(
        `update financial.outbox_messages
      set attempts=attempts+1,last_error_code='SQS_SEND_FAILED',
        next_attempt_at=clock_timestamp()+(?::text||' milliseconds')::interval,
        suspended_at=case when attempts+1>=? then clock_timestamp() else null end,
        claim_token=null,lease_until=null
      where id=? and claim_token=? and lease_until>clock_timestamp() and published_at is null and suspended_at is null
      returning attempts,suspended_at is not null as suspended`,
        [delayMilliseconds, maxAttempts, id, token],
      ),
    );
    return row ? { attempts: row.attempts as number, suspended: row.suspended as boolean } : null;
  }

  async suspend(id: string, token: string, code: OutboxFailureCode): Promise<boolean> {
    const rows = await this.shortTransaction((em) =>
      em.execute(
        `update financial.outbox_messages
      set attempts=attempts+1,last_error_code=?,suspended_at=clock_timestamp(),claim_token=null,lease_until=null
      where id=? and claim_token=? and lease_until>clock_timestamp() and published_at is null and suspended_at is null returning id`,
        [code, id, token],
      ),
    );
    return rows.length === 1;
  }

  async release(id: string, token: string): Promise<boolean> {
    const rows = await this.shortTransaction((em) =>
      em.execute(
        `update financial.outbox_messages set claim_token=null,lease_until=null
      where id=? and claim_token=? and lease_until>clock_timestamp() and published_at is null returning id`,
        [id, token],
      ),
    );
    return rows.length === 1;
  }

  async inspect(id?: string): Promise<OutboxInspection[]> {
    if (id !== undefined && !isUuid(id)) throw new Error('Invalid event ID');
    const rows = await this.shortTransaction((em) =>
      em.execute<Record<string, unknown>[]>(
        `select id,event_type,transaction_id,attempts,
      suspended_at is not null as suspended,published_at is not null as published,last_error_code
      from financial.outbox_messages ${id ? 'where id=?' : ''}
      order by (suspended_at is not null) desc,(published_at is null) desc,occurred_at,id limit 100`,
        id ? [id] : [],
      ),
    );
    return rows.map((row) => ({
      id: row.id as string,
      eventType: row.event_type as string,
      transactionId: row.transaction_id as string,
      attempts: row.attempts as number,
      suspended: row.suspended as boolean,
      published: row.published as boolean,
      lastErrorCode: row.last_error_code as string | null,
    }));
  }

  async resume(id: string, operator: string): Promise<boolean> {
    if (!isUuid(id) || !/^[A-Za-z0-9@._-]{1,128}$/.test(operator))
      throw new Error('Invalid recovery identity');
    return this.shortTransaction(async (em) => {
      const rows = await em.execute(
        `update financial.outbox_messages set suspended_at=null,attempts=0,
        next_attempt_at=clock_timestamp(),claim_token=null,lease_until=null,last_error_code=null
        where id=? and suspended_at is not null and published_at is null returning id`,
        [id],
      );
      if (rows.length !== 1) return false;
      await em.execute(
        'insert into financial.outbox_resume_audit(id,event_id,operator) values(gen_random_uuid(),?,?)',
        [id, operator],
      );
      return true;
    });
  }
}
