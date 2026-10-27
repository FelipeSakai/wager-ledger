import { randomUUID } from 'node:crypto';
import type {
  FinancialObservation,
  FinancialRole,
  FinancialTelemetry,
} from '../../application/ports/financial-telemetry';
import { isUuid } from '../../domain/validation/domain-validation';

const kinds = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'];
const statuses = ['PROCESSED', 'REJECTED', 'FAILED', 'PENDING_REFERENCE'];
const transports = ['http', 'sqs', 'references'];
const failureCodes = [
  'INVALID_OPERATION_AMOUNT',
  'WALLET_PLAYER_MISMATCH',
  'CURRENCY_MISMATCH',
  'REFERENCE_SELF_REFERENCE',
  'REFERENCE_CONTEXT_MISMATCH',
  'REFERENCE_KIND_NOT_ALLOWED',
  'REFERENCE_NOT_PROCESSED',
  'REFERENCE_AMOUNT_MISMATCH',
  'REFERENCE_NOT_FOUND_EXPIRED',
  'REFERENCE_NOT_READY_EXPIRED',
  'REFERENCE_ALREADY_REVERSED',
  'INSUFFICIENT_FUNDS',
  'REVERSAL_INSUFFICIENT_FUNDS',
  'MONEY_OUT_OF_RANGE',
  'INVALID_REFERENCE_STATE',
];
const outcomes = [
  'success',
  'failure',
  'replay',
  'retry',
  'confirmed',
  'lost',
  'suspended',
  'acknowledged',
  'dlq',
  'stopping',
];
const components = ['financial', 'inbox', 'outbox', 'dlq', 'sqs', 'references', 'http'];
const causes = [
  'TRANSIENT',
  'IDENTITY_COLLISION',
  'WALLET_COLLISION',
  'timeout',
  'unavailable',
  'internal',
];
const events = [
  'transaction_transition',
  'transaction_replay',
  'processing_completed',
  'wallet_opened',
  'financial_retry',
  'wallet_lock',
  'lock_conflict',
  'inbox_duplicate',
  'sqs_delivery',
  'outbox_send',
  'outbox_published',
  'outbox_suspended',
  'outbox_claim_lost',
  'outbox_send_failed',
  'outbox_operation_incomplete',
  'dlq_transfer',
  'reconciliation_issue',
  'integrity_failure',
  'dependency_probe',
  'http_request',
  'service_started',
  'service_stopping',
  'worker_poll_failed',
  'reference_scan',
  'sqs_visibility_renewal_failed',
  'sqs_delivery_incomplete',
  'sqs_visibility_update_failed',
];
type Series = { name: string; labels: Record<string, string>; value: number };
const buckets = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30];
export class OperationalTelemetry implements FinancialTelemetry {
  readonly instanceId = randomUUID();
  private readonly series = new Map<string, Series>();
  private readonly types = new Map<string, 'counter' | 'gauge' | 'histogram'>();
  constructor(
    readonly role: FinancialRole,
    private readonly write: (line: string) => void = (line) => console.log(line),
  ) {}
  private add(
    name: string,
    labels: Record<string, string>,
    value: number,
    type: 'counter' | 'gauge' | 'histogram' = 'counter',
  ): void {
    const key = JSON.stringify([name, labels]);
    const previous = this.series.get(key);
    this.types.set(name.replace(/_(bucket|sum|count)$/, ''), type);
    this.series.set(key, {
      name,
      labels,
      value: type === 'gauge' ? value : (previous?.value ?? 0) + value,
    });
  }
  private histogram(name: string, labels: Record<string, string>, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    for (const upper of buckets)
      this.add(
        `${name}_bucket`,
        { ...labels, le: String(upper) },
        seconds <= upper ? 1 : 0,
        'histogram',
      );
    this.add(`${name}_bucket`, { ...labels, le: '+Inf' }, 1, 'histogram');
    this.add(`${name}_sum`, labels, seconds, 'histogram');
    this.add(`${name}_count`, labels, 1, 'histogram');
  }
  observe(input: FinancialObservation): void {
    if (!events.includes(input.event)) return;
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level:
        input.outcome === 'failure' ||
        [
          'integrity_failure',
          'reconciliation_issue',
          'outbox_send_failed',
          'outbox_operation_incomplete',
          'worker_poll_failed',
        ].includes(input.event)
          ? 'error'
          : 'info',
      service: 'wager-ledger',
      role: this.role,
      instanceId: this.instanceId,
      event: input.event,
    };
    for (const key of [
      'correlationId',
      'transactionId',
      'walletId',
      'eventId',
      'transferId',
    ] as const)
      if (isUuid(input[key])) record[key] = input[key];
    if (typeof input.messageId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.messageId))
      record.messageId = input.messageId;
    if (typeof input.providerId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.providerId))
      record.providerId = input.providerId;
    const allowed = {
      failureCode: failureCodes,
      kind: kinds,
      status: statuses,
      transport: transports,
      outcome: outcomes,
      component: components,
      cause: causes,
      dependency: ['postgres', 'sqs'],
    };
    for (const [key, values] of Object.entries(allowed)) {
      const value = input[key as keyof FinancialObservation];
      if (typeof value === 'string' && values.includes(value)) record[key] = value;
    }
    const labels = (keys: string[]) =>
      Object.fromEntries(
        keys.map((key) => [
          key,
          typeof record[key] === 'string' ? (record[key] as string) : 'unknown',
        ]),
      );
    switch (input.event) {
      case 'transaction_transition':
        this.add('wager_transactions_total', labels(['status', 'kind']), 1);
        break;
      case 'transaction_replay':
        this.add('wager_duplicates_total', { layer: 'business' }, 1);
        break;
      case 'inbox_duplicate':
        this.add('wager_duplicates_total', { layer: 'inbox' }, 1);
        break;
      case 'financial_retry':
        this.add('wager_retries_total', labels(['component', 'cause']), 1);
        break;
      case 'lock_conflict':
        this.add('wager_lock_conflicts_total', { cause: 'transient' }, 1);
        break;
      case 'wallet_lock':
        this.histogram(
          'wager_lock_wait_seconds',
          labels(['outcome']),
          input.durationSeconds ?? NaN,
        );
        break;
      case 'http_request':
        this.histogram('http_request_seconds', labels(['outcome']), input.durationSeconds ?? NaN);
        break;
      case 'processing_completed':
        this.histogram(
          'wager_processing_seconds',
          labels(['transport', 'outcome']),
          input.durationSeconds ?? NaN,
        );
        break;
      case 'outbox_send':
        this.add('outbox_publish_attempts_total', labels(['outcome']), 1);
        break;
      case 'outbox_suspended':
        this.add('outbox_suspended_total', {}, 1);
        break;
      case 'dlq_transfer':
        this.add('dlq_transfers_total', labels(['outcome']), 1);
        break;
      case 'sqs_delivery':
        this.add('sqs_deliveries_total', labels(['outcome']), 1);
        break;
      case 'reconciliation_issue':
        this.add('wallet_reconciliation_mismatches_total', {}, 1);
        break;
      case 'integrity_failure':
        this.add('financial_integrity_failures_total', {}, 1);
        break;
      case 'dependency_probe':
        if (input.outcome === 'failure')
          this.add('dependency_probe_failures_total', labels(['dependency', 'cause']), 1);
        break;
    }
    if (
      input.durationSeconds !== undefined &&
      Number.isFinite(input.durationSeconds) &&
      input.durationSeconds >= 0
    )
      record.durationSeconds = input.durationSeconds;
    try {
      this.write(JSON.stringify(record));
    } catch {
      /* Best effort log sink. */
    }
  }
  snapshot(source: 'postgres' | 'sqs', values: Record<string, number> | undefined): void {
    const names =
      source === 'postgres'
        ? [
            'outbox_pending',
            'outbox_lag_seconds',
            'dlq_transfer_pending',
            'dlq_transfer_lag_seconds',
            'pending_references',
          ]
        : ['sqs_dlq_messages'];
    this.add('operational_probe_success', { dependency: source }, values ? 1 : 0, 'gauge');
    if (!values) return; // Keep last observation rather than inventing an empty backlog.
    this.add(
      'operational_probe_last_success_timestamp_seconds',
      { dependency: source },
      Date.now() / 1000,
      'gauge',
    );
    for (const name of names)
      if (Number.isFinite(values[name]) && values[name]! >= 0)
        this.add(name, {}, values[name]!, 'gauge');
  }
  render(): string {
    const escape = (value: string) =>
      value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
    const lines = [...this.types]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, type]) => `# TYPE ${name} ${type}`);
    for (const sample of this.series.values()) {
      const labels = { role: this.role, ...sample.labels };
      lines.push(
        `${sample.name}{${Object.entries(labels)
          .map(([key, value]) => `${key}="${escape(value)}"`)
          .join(',')}} ${sample.value}`,
      );
    }
    return lines.join('\n') + '\n';
  }
}
