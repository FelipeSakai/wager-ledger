import { createOrm } from '../../src/bootstrap/financial-database';
import { DispatchDlq } from '../../src/modules/financial/application/use-cases/dispatch-dlq';
import { ProcessTransaction } from '../../src/modules/financial/application/use-cases/process-transaction';
import { AwsSqsTransport } from '../../src/modules/financial/infrastructure/messaging/aws-sqs-transport';
import { MikroSqsRecoveryStore } from '../../src/modules/financial/infrastructure/messaging/mikro-sqs-recovery-store';
import { MikroFinancialUnitOfWork } from '../../src/modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { systemFinancialRuntime as runtime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';
import { HandleSqsDelivery } from '../../src/modules/financial/presentation/sqs/handle-sqs-delivery';
import { SqsConsumer } from '../../src/modules/financial/presentation/sqs/sqs-consumer';
import { sqsClient } from '../../src/platform/messaging/sqs-client';
function command(type: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = (value: unknown) => {
      if (typeof value === 'object' && value && 'type' in value && value.type === type) {
        process.off('message', listener);
        resolve();
      }
    };
    process.on('message', listener);
  });
}
async function main(): Promise<void> {
  const { WAGER_TEST_DATABASE_URL, SQS_TEST_INPUT, SQS_TEST_DLQ, SQS_TEST_MODE } = process.env;
  if (!WAGER_TEST_DATABASE_URL || !SQS_TEST_INPUT || !SQS_TEST_DLQ || !process.send)
    throw new Error('Test harness required');
  const start = command('START');
  const release = command('RELEASE');
  const orm = await createOrm(WAGER_TEST_DATABASE_URL);
  const client = sqsClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    local: true,
  });
  try {
    const transport = new AwsSqsTransport(client, SQS_TEST_INPUT);
    if (SQS_TEST_MODE === 'lost-visibility') {
      const visibility = transport.visibility.bind(transport);
      let reported = false;
      transport.visibility = async (receipt, seconds) => {
        if (seconds === 1) {
          if (!reported) {
            reported = true;
            process.send?.({ type: 'HEARTBEAT_FAILED', pid: process.pid });
          }
          throw new Error('Injected visibility renewal failure');
        }
        return visibility(receipt, seconds);
      };
    }
    if (SQS_TEST_MODE === 'dispatch-before-send' || SQS_TEST_MODE === 'dispatch-after-send') {
      const send = transport.send.bind(transport);
      transport.send = async (...args) => {
        if (SQS_TEST_MODE === 'dispatch-before-send') {
          process.send?.({ type: 'DLQ_BEFORE_SEND', transferId: args[3], pid: process.pid });
          await release;
        }
        await send(...args);
        if (SQS_TEST_MODE === 'dispatch-after-send') {
          process.send?.({ type: 'DLQ_SENT', transferId: args[3], pid: process.pid });
          await release;
        }
      };
    }
    const recovery = new MikroSqsRecoveryStore(orm);
    const processor = new ProcessTransaction(
      new MikroFinancialUnitOfWork(orm),
      runtime,
      ['provider-a'],
      { lockTimeoutMilliseconds: 5000, statementTimeoutMilliseconds: 10000 },
    );
    const handler = new HandleSqsDelivery(
      processor,
      recovery,
      runtime,
      SQS_TEST_INPUT,
      SQS_TEST_DLQ,
    );
    const dispatcher = new DispatchDlq(recovery, transport, runtime, {
      leaseMilliseconds: 1000,
      maxAttempts: 10,
      baseDelayMilliseconds: 1000,
      maxDelayMilliseconds: 300000,
    });
    const consumer = new SqsConsumer(
      transport,
      {
        execute: async (delivery) => {
          process.send?.({
            type: 'ADMITTED',
            pid: process.pid,
            transportMessageId: delivery.transportMessageId,
            receiptHandle: delivery.receiptHandle,
          });
          const result = await handler.execute(delivery);
          if (SQS_TEST_MODE === 'hold') {
            process.send?.({
              type: 'COMMITTED',
              receiptHandle: delivery.receiptHandle,
              pid: process.pid,
            });
            await release;
          }
          return result;
        },
      },
      dispatcher,
      {
        batchSize: 1,
        waitSeconds: 1,
        visibilitySeconds: SQS_TEST_MODE === 'lost-visibility' ? 1 : 60,
        heartbeatMilliseconds: SQS_TEST_MODE === 'lost-visibility' ? 100 : 20000,
        retryBaseSeconds: 1,
        retryMaxSeconds: 1,
      },
      () => {},
    );
    process.once('SIGTERM', () => consumer.stop());
    process.send({ type: 'READY', pid: process.pid });
    await start;
    if (SQS_TEST_MODE?.startsWith('dispatch')) await dispatcher.execute();
    else {
      let received: number;
      do {
        received = await consumer.pollOnce();
      } while (SQS_TEST_MODE === 'redelivery' && received === 0);
    }
    process.send({ type: 'DONE', pid: process.pid });
  } finally {
    await orm.close(true);
    client.destroy();
    process.disconnect?.();
  }
}
main().catch((error: unknown) => {
  process.send?.({ type: 'ERROR', name: error instanceof Error ? error.name : 'UnknownError' });
  process.disconnect?.();
  process.exitCode = 1;
});
