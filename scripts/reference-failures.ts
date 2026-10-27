import { createOrm } from '../src/bootstrap/financial-database';
import { MikroPendingReferenceStore } from '../src/modules/financial/infrastructure/references/mikro-pending-reference-store';
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL || process.argv.length > 3)
    throw new Error('Usage: bun run references:failures [transactionId]');
  const orm = await createOrm(process.env.DATABASE_URL);
  try {
    console.log(
      JSON.stringify(await new MikroPendingReferenceStore(orm).failures(process.argv[2]), null, 2),
    );
  } finally {
    await orm.close(true);
  }
}
main().catch(() => {
  console.error('Reference failure inspection could not complete');
  process.exitCode = 1;
});
