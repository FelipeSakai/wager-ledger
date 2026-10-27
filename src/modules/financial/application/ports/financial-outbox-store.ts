export interface OutboxClaim {
  id: string;
  transactionId: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: unknown;
  occurredAt: string;
  claimToken: string;
  attempts: number;
}
export type OutboxFailureCode = 'SQS_SEND_FAILED' | 'INVALID_EVENT_ENVELOPE';
export interface OutboxInspection {
  id: string;
  eventType: string;
  transactionId: string;
  attempts: number;
  suspended: boolean;
  published: boolean;
  lastErrorCode: string | null;
}
export interface FinancialOutboxStore {
  claim(limit: number, leaseMilliseconds: number): Promise<OutboxClaim[]>;
  renew(id: string, token: string, leaseMilliseconds: number): Promise<boolean>;
  confirm(id: string, token: string): Promise<boolean>;
  fail(
    id: string,
    token: string,
    delayMilliseconds: number,
    maxAttempts: number,
  ): Promise<{ attempts: number; suspended: boolean } | null>;
  suspend(id: string, token: string, code: OutboxFailureCode): Promise<boolean>;
  release(id: string, token: string): Promise<boolean>;
  inspect(id?: string): Promise<OutboxInspection[]>;
  resume(id: string, operator: string): Promise<boolean>;
}
export interface EventPublicationTransport {
  send(body: string, groupId: string, eventId: string): Promise<void>;
}
export interface OutboxDiagnostic {
  event:
    | 'outbox_published'
    | 'outbox_send_failed'
    | 'outbox_suspended'
    | 'outbox_claim_lost'
    | 'outbox_operation_incomplete';
  eventId: string;
  correlationId?: string;
  transactionId: string;
  walletId: string;
}
