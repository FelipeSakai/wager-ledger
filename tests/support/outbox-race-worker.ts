import { createOrm } from '../../src/bootstrap/financial-database';
import { PublishOutbox } from '../../src/modules/financial/application/use-cases/publish-outbox';
import { MikroFinancialOutboxStore } from '../../src/modules/financial/infrastructure/events/mikro-financial-outbox-store';
import { SqsEventPublication } from '../../src/modules/financial/infrastructure/events/sqs-event-publication';
import { AwsSqsTransport } from '../../src/modules/financial/infrastructure/messaging/aws-sqs-transport';
import { systemFinancialRuntime as runtime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';
import { sqsClient } from '../../src/platform/messaging/sqs-client';
function command(type: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === type
      ) {
        process.off('message', listener);
        resolve();
      }
    };
    process.on('message', listener);
  });
}
async function main(): Promise<void> {
  const { WAGER_TEST_DATABASE_URL, OUTBOX_TEST_QUEUE, OUTBOX_TEST_MODE } = process.env;
  if (!WAGER_TEST_DATABASE_URL || !OUTBOX_TEST_QUEUE || !process.send)
    throw new Error('Test publisher requires its harness');
  const start = command('START');
  const release = command('RELEASE');
  const orm = await createOrm(WAGER_TEST_DATABASE_URL);
  const client = sqsClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    local: true,
  });
  try {
    const sender = new SqsEventPublication(
      new AwsSqsTransport(client, OUTBOX_TEST_QUEUE),
      OUTBOX_TEST_QUEUE,
    );
    let held = false;
    const publisher = new PublishOutbox(
      new MikroFinancialOutboxStore(orm),
      {
        send: async (body, group, id) => {
          if (!held && OUTBOX_TEST_MODE === 'before-send') {
            held = true;
            process.send?.({ type: 'CLAIMED', eventId: id, pid: process.pid });
            await release;
          }
          await sender.send(body, group, id);
          process.send?.({ type: 'SENT', eventId: id, pid: process.pid });
          if (!held && OUTBOX_TEST_MODE === 'after-send') {
            held = true;
            await release;
          }
        },
      },
      runtime,
      { batchSize: 1, leaseMilliseconds: 500, heartbeatMilliseconds: 100 },
      () => {},
    );
    process.once('SIGTERM', () => publisher.stop());
    process.send({ type: 'READY', pid: process.pid });
    await start;
    let published = 0;
    while (true) {
      const result = await publisher.execute();
      published += result.published;
      if (result.claimed === 0) break;
    }
    process.send({ type: 'DONE', pid: process.pid, published });
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
