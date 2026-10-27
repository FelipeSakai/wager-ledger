import type { InboxDecision } from './inbox';

export interface DlqTransfer {
  id: string;
  body: string;
  groupId: string;
  destination: string;
  claimToken: string;
  transactionId?: string;
  correlationId?: string;
  messageId?: string;
  sourceTransportMessageId: string;
  reason: string;
  attempts: number;
}
export interface DlqDiagnostic {
  id: string;
  diagnosticKey: string;
  consumerName: string;
  bodyHash: string;
  body: string;
  sourceQueue: string;
  transportMessageId: string;
  groupId: string;
  destination: string;
  reason: string;
}
export interface SqsRecoveryStore {
  decision(consumerName: string, messageId: string): Promise<InboxDecision | null>;
  diagnose(diagnostic: DlqDiagnostic): Promise<string>;
  confirmed(id: string): Promise<boolean>;
  claim(id: string | undefined, leaseMilliseconds: number): Promise<DlqTransfer | null>;
  confirm(id: string, token: string): Promise<boolean>;
  fail(id: string, token: string, delayMilliseconds: number, maxAttempts: number): Promise<boolean>;
  inspect(): Promise<
    ReadonlyArray<{
      id: string;
      reason: string;
      attempts: number;
      suspended: boolean;
      confirmed: boolean;
    }>
  >;
  resume(id: string, operator: string): Promise<boolean>;
}
