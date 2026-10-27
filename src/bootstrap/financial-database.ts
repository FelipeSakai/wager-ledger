import { Migration202610270001 } from '../modules/financial/infrastructure/persistence/migrations/Migration202610270001';
import { Migration202610270002 } from '../modules/financial/infrastructure/persistence/migrations/Migration202610270002';
import { Migration202610270003 } from '../modules/financial/infrastructure/persistence/migrations/Migration202610270003';
import { Migration202610270004 } from '../modules/financial/infrastructure/persistence/migrations/Migration202610270004';
import { Migration202610270005 } from '../modules/financial/infrastructure/persistence/migrations/Migration202610270005';
import { financialSchemas } from '../modules/financial/infrastructure/persistence/records';
import { createPostgresOrm } from '../platform/database/orm';

export function createOrm(clientUrl: string) {
  return createPostgresOrm(clientUrl, {
    entities: financialSchemas,
    migrations: {
      migrationsList: [
        Migration202610270001,
        Migration202610270002,
        Migration202610270003,
        Migration202610270004,
        Migration202610270005,
      ],
      schema: 'public',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
