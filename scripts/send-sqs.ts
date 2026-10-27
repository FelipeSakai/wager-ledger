import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { readFile } from 'node:fs/promises';
import { AwsSqsTransport } from '../src/modules/financial/infrastructure/messaging/aws-sqs-transport';
import { SqsTransactionProducer } from '../src/modules/financial/presentation/sqs/sqs-transaction-producer';
import { sqsClient } from '../src/platform/messaging/sqs-client';
async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('Envelope file path required');
  const body = await readFile(path, 'utf8');
  const client = sqsClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    local: true,
  });
  try {
    const result = await client.send(
      new GetQueueUrlCommand({
        QueueName: process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo',
      }),
    );
    if (!result.QueueUrl) throw new Error('Queue URL missing');
    await new SqsTransactionProducer(
      new AwsSqsTransport(client, result.QueueUrl),
      result.QueueUrl,
    ).send(body);
    console.log('SQS envelope accepted');
  } finally {
    client.destroy();
  }
}
main().catch(() => {
  console.error('SQS send failed');
  process.exitCode = 1;
});
