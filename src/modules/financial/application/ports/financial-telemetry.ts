export type FinancialRole = 'http' | 'sqs' | 'outbox' | 'references';
export interface FinancialObservation {
  event: string;
  correlationId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  messageId?: string;
  eventId?: string;
  transferId?: string;
  failureCode?: string;
  kind?: string;
  status?: string;
  transport?: string;
  outcome?: string;
  cause?: string;
  component?: string;
  dependency?: string;
  durationSeconds?: number;
}
export interface FinancialTelemetry {
  observe(observation: FinancialObservation): void;
}
export const silentTelemetry: FinancialTelemetry = Object.freeze({ observe: () => {} });
// Instrumentation is best effort, including implementations injected by callers.
export function report(telemetry: FinancialTelemetry, observation: FinancialObservation): void {
  try {
    telemetry.observe(observation);
  } catch {
    /* Financial results must survive telemetry failure. */
  }
}

// One mutable context per operation/admission. Identifiers are added as they become
// known; no process-global context or financial payload is shared across requests.
export interface FinancialOperationContext {
  correlationId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  messageId?: string;
}
export function operationTelemetry(
  telemetry: FinancialTelemetry,
  context: FinancialOperationContext,
): FinancialTelemetry {
  return {
    observe: (observation) =>
      report(telemetry, {
        correlationId: context.correlationId,
        transactionId: context.transactionId,
        walletId: context.walletId,
        providerId: context.providerId,
        messageId: context.messageId,
        ...observation,
      }),
  };
}
