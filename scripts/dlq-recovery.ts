import { createOrm } from '../src/bootstrap/financial-database';
import { isUuid } from '../src/modules/financial/domain/validation/domain-validation';
import { MikroSqsRecoveryStore } from '../src/modules/financial/infrastructure/messaging/mikro-sqs-recovery-store';
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const orm = await createOrm(process.env.DATABASE_URL);
  try {
    const store = new MikroSqsRecoveryStore(orm);
    const [action, id, operator] = process.argv.slice(2);
    if (action === 'inspect') console.log(await store.inspect());
    else if (action === 'resume' && isUuid(id) && operator)
      console.log({ resumed: await store.resume(id, operator) });
    else throw new Error('Use inspect or resume <transferId> <operator>');
  } finally {
    await orm.close(true);
  }
}
main().catch(() => {
  console.error('DLQ recovery command failed');
  process.exitCode = 1;
});
