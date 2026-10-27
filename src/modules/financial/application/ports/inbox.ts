export interface InboxDelivery {
  id: string;
  consumerName: string;
  messageId: string;
  payloadHash: string;
  body: string;
  sourceQueue: string;
  transportMessageId: string;
  groupId: string;
  dlqQueue: string;
  receivedAt: Date;
}
export interface InboxDecision {
  inboxId: string;
  transactionId: string;
  disposition: 'ACK_AFTER_COMMIT' | 'DLQ_REQUIRED';
  transferId?: string;
  dlqConfirmed: boolean;
}
