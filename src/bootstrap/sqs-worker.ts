import { ProcessShutdown, closeResources } from '../platform/process/shutdown';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { DispatchDlq } from '../modules/financial/application/use-cases/dispatch-dlq';
import { ProcessTransaction } from '../modules/financial/application/use-cases/process-transaction';
import { AwsSqsTransport } from '../modules/financial/infrastructure/messaging/aws-sqs-transport';
import { MikroSqsRecoveryStore } from '../modules/financial/infrastructure/messaging/mikro-sqs-recovery-store';
import { OperationalTelemetry } from '../modules/financial/infrastructure/observability/operational-telemetry';
import { MikroFinancialUnitOfWork } from '../modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { systemFinancialRuntime as runtime } from '../modules/financial/infrastructure/runtime/system-financial-runtime';
import { HandleSqsDelivery } from '../modules/financial/presentation/sqs/handle-sqs-delivery';
import {
  SqsConsumer,
  defaultSqsConsumerOptions,
} from '../modules/financial/presentation/sqs/sqs-consumer';
import { sqsClient } from '../platform/messaging/sqs-client';
import { createOrm } from './financial-database';
import { workerOperations } from './worker-operations';

const processTelemetry = new OperationalTelemetry('sqs');
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
  const client = sqsClient({
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    local: true,
  });
  const orm = await createOrm(process.env.DATABASE_URL);
  let operations: Awaited<ReturnType<typeof workerOperations>> | undefined;
  let shutdown: ProcessShutdown | undefined;
  try {
    const input = await client.send(
      new GetQueueUrlCommand({
        QueueName: process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo',
      }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
    const dlq = await client.send(
      new GetQueueUrlCommand({
        QueueName: process.env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
      }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
    if (!input.QueueUrl || !dlq.QueueUrl) throw new Error('Run SQS setup before the worker');
    operations = await workerOperations(
      'sqs',
      orm,
      client,
      [
        { name: process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo', dlq: false },
        { name: process.env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo', dlq: true },
      ],
      processTelemetry,
    );
    const telemetry = operations.telemetry;
    const transport = new AwsSqsTransport(client, input.QueueUrl);
    const recovery = new MikroSqsRecoveryStore(orm);
    const processor = new ProcessTransaction(
      new MikroFinancialUnitOfWork(orm, telemetry),
      runtime,
      (process.env.FINANCIAL_PROVIDERS ?? 'provider-a,provider-b').split(','),
      {},
      telemetry,
    );
    const dispatcher = new DispatchDlq(recovery, transport, runtime, undefined, telemetry);
    const consumer = new SqsConsumer(
      transport,
      new HandleSqsDelivery(
        processor,
        recovery,
        runtime,
        input.QueueUrl,
        dlq.QueueUrl,
        'wager-transactions-v1',
        telemetry,
      ),
      dispatcher,
      {
        ...defaultSqsConsumerOptions,
        batchSize: Number(process.env.SQS_BATCH_SIZE ?? '10'),
        visibilitySeconds: Number(process.env.SQS_VISIBILITY_SECONDS ?? '60'),
        heartbeatMilliseconds: Number(process.env.SQS_HEARTBEAT_MILLISECONDS ?? '20000'),
      },
      (event, context) => telemetry.observe({ event, ...context, outcome: 'failure' }),
      telemetry,
    );
    const shutdownMilliseconds = Number(process.env.SQS_SHUTDOWN_MILLISECONDS ?? '30000');
    if (!Number.isSafeInteger(shutdownMilliseconds) || shutdownMilliseconds < 1)
      throw new Error('Invalid shutdown budget');
    let stopped = false;
    shutdown = new ProcessShutdown(shutdownMilliseconds, () => {
      operations!.service.stop();
      stopped = true;
      consumer.stop();
    });
    const consume = async () => {
      while (!stopped) {
        try {
          await consumer.pollOnce();
        } catch {
          telemetry.observe({ event: 'worker_poll_failed', component: 'sqs', outcome: 'failure' });
          if (!stopped) await runtime.sleep(1000);
        }
      }
    };
    const recover = async () => {
      while (!stopped) {
        try {
          await dispatcher.execute();
        } catch {
          telemetry.observe({ event: 'worker_poll_failed', component: 'dlq', outcome: 'failure' });
        }
        if (!stopped) await runtime.sleep(1000);
      }
    };
    operations.service.start();
    const tasks = Promise.all([consume(), recover()]);
    await tasks;
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
    component: 'sqs',
    outcome: 'failure',
    cause: 'internal',
  });
  process.exitCode = 1;
});
