import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export async function setupSqsQueues(
  client: SQSClient,
  inputName = 'wager-transactions.fifo',
  dlqName = 'wager-transactions-dlq.fifo',
  maxReceiveCount = 5,
) {
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        MessageRetentionPeriod: '1209600',
      },
    }),
  );
  if (!dlq.QueueUrl) throw new Error('DLQ URL missing');
  const attrs = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  if (!attrs.Attributes?.QueueArn) throw new Error('DLQ ARN missing');
  const redrive = JSON.stringify({
    deadLetterTargetArn: attrs.Attributes.QueueArn,
    maxReceiveCount,
  });
  const input = await client.send(
    new CreateQueueCommand({
      QueueName: inputName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '60',
        ReceiveMessageWaitTimeSeconds: '20',
        MessageRetentionPeriod: '345600',
      },
    }),
  );
  if (!input.QueueUrl) throw new Error('Input queue URL missing');
  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: input.QueueUrl,
      Attributes: { RedrivePolicy: redrive },
    }),
  );
  return { input: input.QueueUrl, dlq: dlq.QueueUrl };
}
