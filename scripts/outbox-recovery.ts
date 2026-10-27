import { createOrm } from '../src/bootstrap/financial-database';
import { isUuid } from '../src/modules/financial/domain/validation/domain-validation';
import { MikroFinancialOutboxStore } from '../src/modules/financial/infrastructure/events/mikro-financial-outbox-store';
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const orm = await createOrm(process.env.DATABASE_URL);
  try {
    const store = new MikroFinancialOutboxStore(orm);
    const [action, id, operator] = process.argv.slice(2);
    if (action === 'inspect' && (id === undefined || isUuid(id)))
      console.log(await store.inspect(id));
    else if (action === 'resume' && isUuid(id) && operator)
      console.log({ resumed: await store.resume(id, operator) });
    else throw new Error('Use inspect [eventId] or resume <eventId> <operator>');
  } finally {
    await orm.close(true);
  }
}
main().catch(() => {
  console.error('Outbox recovery command failed');
  process.exitCode = 1;
});
