import { randomUUID } from 'node:crypto';
import { createOrm } from '../../src/bootstrap/financial-database';

export async function financialTestDatabase() {
  const name = `wager_test_${randomUUID().replaceAll('-', '')}`;
  const inDatabase = (value: string) => {
    const url = new URL(value);
    url.pathname = name;
    return url.href;
  };
  const admin = await createOrm(
    process.env.TEST_DATABASE_ADMIN_URL ??
      'postgresql://wager_admin:wager_admin_local@127.0.0.1:55439/postgres',
  );
  let owner: Awaited<ReturnType<typeof createOrm>> | undefined;
  let app: Awaited<ReturnType<typeof createOrm>> | undefined;
  let observer: Awaited<ReturnType<typeof createOrm>> | undefined;
  let created = false;
  const close = async () => {
    if (observer) await observer.close(true);
    if (app) await app.close(true);
    if (owner) await owner.close(true);
    if (created) await admin.em.fork().execute(`drop database "${name}" with (force)`);
    await admin.close(true);
  };
  try {
    await admin.em.fork().execute(`create database "${name}" owner wager_migrator`);
    created = true;
    owner = await createOrm(
      inDatabase(
        process.env.MIGRATION_DATABASE_URL ??
          'postgresql://wager_migrator:wager_migrator_local@127.0.0.1:55439/wager_ledger',
      ),
    );
    await owner.migrator.up();
    const url = inDatabase(
      process.env.DATABASE_URL ??
        'postgresql://wager_app:wager_app_local@127.0.0.1:55439/wager_ledger',
    );
    app = await createOrm(url);
    observer = await createOrm(url);
    return { name, url, admin, owner, app, observer, close };
  } catch (error) {
    await close();
    throw error;
  }
}
