export interface QueueDelivery {
  body: string;
  transportMessageId: string;
  receiptHandle: string;
  groupId: string;
  receiveCount: number;
}
export interface SqsTransport {
  receive(
    maximum: number,
    waitSeconds: number,
    visibilitySeconds: number,
    signal?: AbortSignal,
  ): Promise<QueueDelivery[]>;
  acknowledge(receiptHandle: string): Promise<void>;
  visibility(receiptHandle: string, seconds: number): Promise<void>;
  send(
    destination: string,
    body: string,
    groupId: string,
    deduplicationId: string,
    attributes?: Record<string, string>,
  ): Promise<void>;
}
