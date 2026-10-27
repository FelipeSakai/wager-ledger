import { Migrator } from '@mikro-orm/migrations';
import { MikroORM, type Options } from '@mikro-orm/postgresql';

export async function createPostgresOrm(
  clientUrl: string,
  registration: Pick<Options, 'entities' | 'migrations'>,
): Promise<MikroORM> {
  const url = new URL(clientUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Database URL must use PostgreSQL');
  }
  const orm = new MikroORM({
    clientUrl,
    schema: 'public',
    entities: registration.entities,
    extensions: [Migrator],
    migrations: registration.migrations,
    pool: { min: 0, max: 5 },
    driverOptions: {
      connectionTimeoutMillis: 2000,
      application_name: url.searchParams.get('application_name') ?? 'wager-ledger',
    },
    debug: false,
  });
  try {
    await orm.connect();
  } catch (error: unknown) {
    await orm.close(true);
    throw error;
  }
  return orm;
}
