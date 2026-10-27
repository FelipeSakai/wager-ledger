import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { FinancialRole } from '../modules/financial/application/ports/financial-telemetry';
import {
  LocalDependencyProbes,
  type ObservedQueue,
} from '../modules/financial/infrastructure/observability/dependency-probes';
import { OperationalTelemetry } from '../modules/financial/infrastructure/observability/operational-telemetry';
import {
  closeOperationalServer,
  OperationalService,
  startOperationalServer,
} from '../platform/observability/operational-service';
export async function workerOperations(
  role: Exclude<FinancialRole, 'http'>,
  orm: MikroORM,
  client?: SQSClient,
  queues: readonly ObservedQueue[] = [],
  telemetry = new OperationalTelemetry(role),
) {
  const defaults = { sqs: 3101, outbox: 3102, references: 3103 };
  const keys = {
    sqs: 'SQS_OPERATIONS_PORT',
    outbox: 'OUTBOX_OPERATIONS_PORT',
    references: 'REFERENCE_OPERATIONS_PORT',
  };
  const service = new OperationalService(
    telemetry,
    new LocalDependencyProbes(orm, client, queues),
    Number(process.env.PROBE_TIMEOUT_MILLISECONDS ?? '2000'),
    Number(process.env.PROBE_INTERVAL_MILLISECONDS ?? '15000'),
  );
  const server = await startOperationalServer(
    service,
    Number(process.env[keys[role]] ?? defaults[role]),
    process.env.OPERATIONS_HOST ?? '127.0.0.1',
  );
  return {
    service,
    telemetry,
    close: async () => {
      service.stop();
      await closeOperationalServer(server);
      await service.close();
    },
  };
}
