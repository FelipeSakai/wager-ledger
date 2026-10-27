import { setupSqsQueues } from '../src/modules/financial/infrastructure/messaging/setup-sqs-queues';
import { sqsClient } from '../src/platform/messaging/sqs-client';
async function main(): Promise<void> {
  const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
  const client = sqsClient({
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    local: true,
  });
  try {
    const commands = await setupSqsQueues(
      client,
      process.env.SQS_QUEUE_NAME,
      process.env.SQS_DLQ_NAME,
    );
    const events = await setupSqsQueues(
      client,
      process.env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo',
      process.env.SQS_EVENTS_DLQ_NAME ?? 'wager-events-dlq.fifo',
    );
    console.log({ commands, events });
  } finally {
    client.destroy();
  }
}
main().catch(() => {
  console.error('SQS setup failed');
  process.exitCode = 1;
});
