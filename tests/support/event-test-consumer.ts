import type { MikroORM } from '@mikro-orm/postgresql';
import { createHash } from 'node:crypto';
import {
  isRecord,
  isUuid,
  isWalletVersion,
} from '../../src/modules/financial/domain/validation/domain-validation';

export async function prepareEventConsumer(owner: MikroORM): Promise<void> {
  await owner.em.fork()
    .execute(`create table public.test_event_inbox(event_id uuid primary key,payload_hash text not null);
    create table public.test_wallet_projection(wallet_id uuid primary key,version bigint not null,balance text not null);
    grant select,insert on public.test_event_inbox to wager_app;
    grant select,insert,update on public.test_wallet_projection to wager_app;`);
}
export class EventTestConsumer {
  constructor(private readonly orm: MikroORM) {}
  async receive(body: string): Promise<boolean> {
    const envelope: unknown = JSON.parse(body);
    if (!isRecord(envelope) || !isUuid(envelope.eventId) || !isRecord(envelope.data))
      throw new Error('Invalid test event');
    const data = envelope.data;
    return this.orm.em.fork().transactional(async (em) => {
      const hash = createHash('sha256').update(body, 'utf8').digest('hex');
      const inserted = await em.execute(
        'insert into public.test_event_inbox(event_id,payload_hash) values(?,?) on conflict do nothing returning event_id',
        [envelope.eventId, hash],
      );
      if (!inserted.length) {
        const [existing] = await em.execute(
          'select payload_hash from public.test_event_inbox where event_id=?',
          [envelope.eventId],
        );
        if (existing?.payload_hash !== hash)
          throw new Error('Duplicate event has different content');
        return false;
      }
      if (envelope.eventType === 'WalletBalanceChanged') {
        if (
          !isUuid(data.walletId) ||
          !isWalletVersion(data.walletVersion) ||
          !isRecord(data.balanceAfter) ||
          typeof data.balanceAfter.amount !== 'string' ||
          !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(data.balanceAfter.amount)
        )
          throw new Error('Invalid projection event');
        await em.execute(
          `insert into public.test_wallet_projection(wallet_id,version,balance) values(?,?,?)
          on conflict(wallet_id) do update set version=excluded.version,balance=excluded.balance
          where test_wallet_projection.version<excluded.version`,
          [data.walletId, data.walletVersion, data.balanceAfter.amount],
        );
      }
      return true;
    });
  }
}
