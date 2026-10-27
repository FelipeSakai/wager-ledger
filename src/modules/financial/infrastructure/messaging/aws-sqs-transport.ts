import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { QueueDelivery, SqsTransport } from '../../application/ports/queue-transport';

export class AwsSqsTransport implements SqsTransport {
  constructor(
    readonly client: SQSClient,
    readonly queueUrl: string,
  ) {}
  async receive(
    maximum: number,
    waitSeconds: number,
    visibilitySeconds: number,
    signal?: AbortSignal,
  ): Promise<QueueDelivery[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: maximum,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: visibilitySeconds,
        MessageSystemAttributeNames: ['MessageGroupId', 'ApproximateReceiveCount'],
      }),
      {
        abortSignal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout((waitSeconds + 5) * 1000)])
          : AbortSignal.timeout((waitSeconds + 5) * 1000),
      },
    );
    return (response.Messages ?? []).map((message) => {
      if (
        !message.Body ||
        !message.MessageId ||
        !message.ReceiptHandle ||
        !message.Attributes?.MessageGroupId
      )
        throw new Error('Queue delivery lacks required transport metadata');
      return {
        body: message.Body,
        transportMessageId: message.MessageId,
        receiptHandle: message.ReceiptHandle,
        groupId: message.Attributes.MessageGroupId,
        receiveCount: Number(message.Attributes.ApproximateReceiveCount ?? '1'),
      };
    });
  }
  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
  }
  async visibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
  }
  async send(
    destination: string,
    body: string,
    groupId: string,
    deduplicationId: string,
    attributes: Record<string, string> = {},
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: destination,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
        MessageAttributes: Object.fromEntries(
          Object.entries(attributes).map(([name, value]) => [
            name,
            { DataType: 'String', StringValue: value },
          ]),
        ),
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
  }
}
