import type { MikroORM } from '@mikro-orm/postgresql';
import type {
  DlqDiagnostic,
  DlqTransfer,
  SqsRecoveryStore,
} from '../../application/ports/dlq-recovery-store';
import type { InboxDecision } from '../../application/ports/inbox';

export class MikroSqsRecoveryStore implements SqsRecoveryStore {
  constructor(private readonly orm: MikroORM) {}
  async decision(consumerName: string, messageId: string): Promise<InboxDecision | null> {
    const [row] = await this.orm.em.fork().execute<Record<string, unknown>[]>(
      `select i.id,i.transaction_id,i.disposition,i.transfer_id,d.dlq_confirmed_at
      from financial.sqs_inbox i left join financial.dlq_transfers d on d.id=i.transfer_id where i.consumer_name=? and i.message_id=?`,
      [consumerName, messageId],
    );
    return row
      ? {
          inboxId: row.id as string,
          transactionId: row.transaction_id as string,
          disposition: row.disposition as InboxDecision['disposition'],
          transferId: (row.transfer_id as string | null) ?? undefined,
          dlqConfirmed: row.dlq_confirmed_at !== null,
        }
      : null;
  }
  async diagnose(d: DlqDiagnostic): Promise<string> {
    return this.orm.em.fork().transactional(async (em) => {
      const [row] = await em.execute<Record<string, unknown>[]>(
        `insert into financial.dlq_transfers
        (id,diagnostic_key,consumer_name,source_queue,source_transport_message_id,body_hash,body,destination,group_id,reason)
        values(?,?,?,?,?,?,?,?,?,?) on conflict(diagnostic_key) do nothing returning id`,
        [
          d.id,
          d.diagnosticKey,
          d.consumerName,
          d.sourceQueue,
          d.transportMessageId,
          d.bodyHash,
          d.body,
          d.destination,
          d.groupId,
          d.reason,
        ],
      );
      if (row) return row.id as string;
      const [existing] = await em.execute<Record<string, unknown>[]>(
        'select id from financial.dlq_transfers where diagnostic_key=?',
        [d.diagnosticKey],
      );
      if (!existing) throw new Error('Diagnostic transfer was not recorded');
      return existing.id as string;
    });
  }
  async confirmed(id: string): Promise<boolean> {
    const [row] = await this.orm.em
      .fork()
      .execute<Record<string, unknown>[]>(
        'select dlq_confirmed_at is not null as confirmed from financial.dlq_transfers where id=?',
        [id],
      );
    return row?.confirmed === true;
  }
  async claim(id: string | undefined, leaseMilliseconds: number): Promise<DlqTransfer | null> {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds <= 0)
      throw new RangeError('Invalid lease');
    const [row] = await this.orm.em.fork().transactional((em) =>
      em.execute<Record<string, unknown>[]>(
        `with candidate as (
      select id from financial.dlq_transfers where dlq_confirmed_at is null and suspended_at is null
      and next_attempt_at<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp())
      ${id ? 'and id=?' : ''} order by created_at,id for update skip locked limit 1)
      update financial.dlq_transfers d set claim_token=gen_random_uuid(), lease_until=clock_timestamp()+(?::text||' milliseconds')::interval
      from candidate c where d.id=c.id returning d.*,
        (select i.message_id from financial.sqs_inbox i where i.id=d.origin_inbox_id) as message_id,
        (select o.payload->>'correlationId' from financial.outbox_messages o where o.transaction_id=d.transaction_id
          and o.event_type='WagerTransactionPendingReference' limit 1) as correlation_id`,
        id ? [id, leaseMilliseconds] : [leaseMilliseconds],
      ),
    );
    return row
      ? {
          transactionId: row.transaction_id as string | undefined,
          correlationId: row.correlation_id as string | undefined,
          messageId: row.message_id as string | undefined,
          id: row.id as string,
          body: row.body as string,
          groupId: row.group_id as string,
          destination: row.destination as string,
          claimToken: row.claim_token as string,
          sourceTransportMessageId: row.source_transport_message_id as string,
          reason: row.reason as string,
          attempts: row.attempts as number,
        }
      : null;
  }
  async confirm(id: string, token: string): Promise<boolean> {
    const rows = await this.orm.em.fork().execute(
      `update financial.dlq_transfers set dlq_confirmed_at=clock_timestamp(),claim_token=null,lease_until=null
      where id=? and claim_token=? and lease_until>clock_timestamp() and dlq_confirmed_at is null returning id`,
      [id, token],
    );
    return rows.length === 1;
  }
  async fail(
    id: string,
    token: string,
    delayMilliseconds: number,
    maxAttempts: number,
  ): Promise<boolean> {
    const rows = await this.orm.em.fork().execute(
      `update financial.dlq_transfers set attempts=attempts+1,
      next_attempt_at=clock_timestamp()+(?::text||' milliseconds')::interval,
      suspended_at=case when attempts+1>=? then clock_timestamp() else null end,claim_token=null,lease_until=null
      where id=? and claim_token=? and lease_until>clock_timestamp() and dlq_confirmed_at is null returning id`,
      [delayMilliseconds, maxAttempts, id, token],
    );
    return rows.length === 1;
  }
  async inspect() {
    const rows = await this.orm.em.fork().execute<
      Record<string, unknown>[]
    >(`select id,reason,attempts,suspended_at is not null as suspended,
      dlq_confirmed_at is not null as confirmed from financial.dlq_transfers order by created_at,id limit 100`);
    return rows.map((row) => ({
      id: row.id as string,
      reason: row.reason as string,
      attempts: row.attempts as number,
      suspended: row.suspended as boolean,
      confirmed: row.confirmed as boolean,
    }));
  }
  async resume(id: string, operator: string): Promise<boolean> {
    if (!/^[A-Za-z0-9@._-]{1,128}$/.test(operator)) throw new Error('Operator identity is invalid');
    return this.orm.em.fork().transactional(async (em) => {
      const rows = await em.execute(
        `update financial.dlq_transfers set suspended_at=null,attempts=0,next_attempt_at=clock_timestamp(),claim_token=null,lease_until=null
        where id=? and dlq_confirmed_at is null and suspended_at is not null returning id`,
        [id],
      );
      if (rows.length !== 1) return false;
      await em.execute(
        'insert into financial.dlq_resume_audit(id,transfer_id,operator) values(gen_random_uuid(),?,?)',
        [id, operator],
      );
      return true;
    });
  }
}
