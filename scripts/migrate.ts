import { createOrm } from '../src/bootstrap/financial-database';

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL for the dedicated migration role');
  const action = process.argv[2] ?? 'up';
  if (!['up', 'down', 'list'].includes(action)) throw new Error('Use migrate.ts up, down or list');
  const orm = await createOrm(url);
  try {
    const migrator = orm.migrator;
    if (action === 'up') await migrator.up();
    else if (action === 'down') await migrator.down();
    else console.log(await migrator.getExecuted());
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : 'MigrationError');
  process.exitCode = 1;
});
