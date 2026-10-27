import { ProcessShutdown, closeResources } from '../platform/process/shutdown';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { PublishOutbox } from '../modules/financial/application/use-cases/publish-outbox';
import { MikroFinancialOutboxStore } from '../modules/financial/infrastructure/events/mikro-financial-outbox-store';
import { SqsEventPublication } from '../modules/financial/infrastructure/events/sqs-event-publication';
import { AwsSqsTransport } from '../modules/financial/infrastructure/messaging/aws-sqs-transport';
import { OperationalTelemetry } from '../modules/financial/infrastructure/observability/operational-telemetry';
import { systemFinancialRuntime as runtime } from '../modules/financial/infrastructure/runtime/system-financial-runtime';
import { sqsClient } from '../platform/messaging/sqs-client';
import { createOrm } from './financial-database';
import { workerOperations } from './worker-operations';

const processTelemetry = new OperationalTelemetry('outbox');
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const client = sqsClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    region: process.env.AWS_REGION ?? 'us-east-1',
    local: true,
  });
  const orm = await createOrm(process.env.DATABASE_URL);
  let operations: Awaited<ReturnType<typeof workerOperations>> | undefined;
  let shutdown: ProcessShutdown | undefined;
  try {
    const queue = await client.send(
      new GetQueueUrlCommand({
        QueueName: process.env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo',
      }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
    if (!queue.QueueUrl) throw new Error('Run SQS setup before the publisher');
    operations = await workerOperations(
      'outbox',
      orm,
      client,
      [
        { name: process.env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo', dlq: false },
        { name: process.env.SQS_EVENTS_DLQ_NAME ?? 'wager-events-dlq.fifo', dlq: true },
      ],
      processTelemetry,
    );
    const telemetry = operations.telemetry;
    const publisher = new PublishOutbox(
      new MikroFinancialOutboxStore(orm),
      new SqsEventPublication(new AwsSqsTransport(client, queue.QueueUrl), queue.QueueUrl),
      runtime,
      {
        batchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? '10'),
        leaseMilliseconds: Number(process.env.OUTBOX_LEASE_MILLISECONDS ?? '30000'),
        heartbeatMilliseconds: Number(process.env.OUTBOX_HEARTBEAT_MILLISECONDS ?? '10000'),
        maxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS ?? '10'),
      },
      () => {},
      telemetry,
    );
    const shutdownMilliseconds = Number(process.env.OUTBOX_SHUTDOWN_MILLISECONDS ?? '30000');
    if (!Number.isSafeInteger(shutdownMilliseconds) || shutdownMilliseconds < 1)
      throw new Error('Invalid publisher shutdown budget');
    let stopped = false;
    shutdown = new ProcessShutdown(shutdownMilliseconds, () => {
      operations!.service.stop();
      stopped = true;
      publisher.stop();
    });
    operations.service.start();
    while (!stopped) {
      try {
        const result = await publisher.execute();
        if (result.claimed === 0 && !stopped)
          await runtime.sleep(750 + Math.floor(runtime.random() * 500));
      } catch {
        telemetry.observe({ event: 'worker_poll_failed', component: 'outbox', outcome: 'failure' });
        if (!stopped) await runtime.sleep(1000);
      }
    }
  } finally {
    try {
      await closeResources([
        async () => {
          if (operations) await operations.close();
        },
        () => orm.close(true),
        () => client.destroy(),
      ]);
    } catch (error: unknown) {
      shutdown?.request();
      throw error;
    }
    shutdown?.complete();
  }
}
main().catch(() => {
  processTelemetry.observe({
    event: 'worker_poll_failed',
    component: 'outbox',
    outcome: 'failure',
    cause: 'internal',
  });
  process.exitCode = 1;
});
