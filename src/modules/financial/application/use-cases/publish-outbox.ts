import { isRecord, isUuid } from '../../domain/validation/domain-validation';
import { InvalidOutboxEnvelope, serializeOutboxEnvelope } from '../events/outbox-envelope';
import type {
  EventPublicationTransport,
  FinancialOutboxStore,
  OutboxClaim,
  OutboxDiagnostic,
} from '../ports/financial-outbox-store';
import type { FinancialRuntime } from '../ports/financial-runtime';
import { report, silentTelemetry, type FinancialTelemetry } from '../ports/financial-telemetry';

export interface OutboxPublisherPolicy {
  batchSize: number;
  leaseMilliseconds: number;
  heartbeatMilliseconds: number;
  maxAttempts: number;
  baseDelayMilliseconds: number;
  maxDelayMilliseconds: number;
}
export const defaultOutboxPublisherPolicy: Readonly<OutboxPublisherPolicy> = Object.freeze({
  batchSize: 10,
  leaseMilliseconds: 30000,
  heartbeatMilliseconds: 10000,
  maxAttempts: 10,
  baseDelayMilliseconds: 1000,
  maxDelayMilliseconds: 300000,
});

export class PublishOutbox {
  private stopping = false;
  private readonly policy: Readonly<OutboxPublisherPolicy>;
  private readonly totals = { published: 0, sendFailures: 0, suspended: 0, lostClaims: 0 };

  constructor(
    private readonly store: FinancialOutboxStore,
    private readonly transport: EventPublicationTransport,
    private readonly runtime: FinancialRuntime,
    policy: Partial<OutboxPublisherPolicy> = {},
    private readonly log: (diagnostic: OutboxDiagnostic) => void = (diagnostic) =>
      console.error(
        JSON.stringify({
          level: diagnostic.event === 'outbox_published' ? 'info' : 'error',
          ...diagnostic,
        }),
      ),
    private readonly telemetry: FinancialTelemetry = silentTelemetry,
  ) {
    const configured = { ...defaultOutboxPublisherPolicy, ...policy };
    if (
      Object.values(configured).some((value) => !Number.isSafeInteger(value) || value < 1) ||
      configured.batchSize > 10 ||
      configured.heartbeatMilliseconds >= configured.leaseMilliseconds ||
      configured.maxDelayMilliseconds < configured.baseDelayMilliseconds
    )
      throw new RangeError('Invalid outbox publisher policy');
    this.policy = Object.freeze(configured);
  }
  stop(): void {
    this.stopping = true;
  }
  counters() {
    return { ...this.totals };
  }

  async execute(): Promise<{ claimed: number; published: number }> {
    if (this.stopping) return { claimed: 0, published: 0 };
    const claims = await this.store.claim(this.policy.batchSize, this.policy.leaseMilliseconds);
    const results = await Promise.allSettled(claims.map((claim) => this.publish(claim)));
    results.forEach((result, index) => {
      if (result.status === 'rejected') this.record('outbox_operation_incomplete', claims[index]!);
    });
    return {
      claimed: claims.length,
      published: results.filter((result) => result.status === 'fulfilled' && result.value).length,
    };
  }

  private async publish(claim: OutboxClaim): Promise<boolean> {
    if (this.stopping) {
      await this.store.release(claim.id, claim.claimToken);
      return false;
    }
    if (!(await this.store.renew(claim.id, claim.claimToken, this.policy.leaseMilliseconds))) {
      this.lost(claim);
      return false;
    }
    let body: string;
    try {
      body = serializeOutboxEnvelope(claim);
    } catch (error: unknown) {
      if (!(error instanceof InvalidOutboxEnvelope)) throw error;
      if (await this.store.suspend(claim.id, claim.claimToken, 'INVALID_EVENT_ENVELOPE')) {
        this.totals.suspended++;
        this.record('outbox_suspended', claim);
      }
      return false;
    }
    if (this.stopping) {
      await this.store.release(claim.id, claim.claimToken);
      return false;
    }
    let lost = false;
    let renewing: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = this.store
        .renew(claim.id, claim.claimToken, this.policy.leaseMilliseconds)
        .then((owned) => {
          if (!owned) lost = true;
        })
        .catch(() => {
          lost = true;
        })
        .finally(() => {
          renewing = undefined;
        });
    }, this.policy.heartbeatMilliseconds);
    const stopHeartbeat = async () => {
      clearInterval(heartbeat);
      await renewing;
    };
    try {
      try {
        await this.transport.send(body, claim.aggregateId, claim.id);
        report(this.telemetry, { event: 'outbox_send', outcome: 'success', eventId: claim.id });
      } catch {
        await stopHeartbeat();
        report(this.telemetry, { event: 'outbox_send', outcome: 'failure', eventId: claim.id });
        this.totals.sendFailures++;
        this.record('outbox_send_failed', claim);
        if (!lost) {
          const ceiling = Math.min(
            this.policy.maxDelayMilliseconds,
            this.policy.baseDelayMilliseconds * 2 ** Math.min(claim.attempts, 20),
          );
          const delay = Math.max(1, Math.floor(ceiling * (0.5 + this.runtime.random() * 0.5)));
          const failed = await this.store.fail(
            claim.id,
            claim.claimToken,
            delay,
            this.policy.maxAttempts,
          );
          if (failed?.suspended) {
            this.totals.suspended++;
            this.record('outbox_suspended', claim);
          }
        } else this.lost(claim);
        return false;
      }
      await stopHeartbeat();
      if (lost) {
        this.lost(claim);
        return false;
      }
      const published = await this.store.confirm(claim.id, claim.claimToken);
      if (published) {
        this.totals.published++;
        this.record('outbox_published', claim);
      } else this.lost(claim);
      return published;
    } finally {
      await stopHeartbeat();
    }
  }
  private lost(claim: OutboxClaim): void {
    this.totals.lostClaims++;
    this.record('outbox_claim_lost', claim);
  }
  private record(event: OutboxDiagnostic['event'], claim: OutboxClaim): void {
    const correlationId =
      isRecord(claim.payload) && isUuid(claim.payload.correlationId)
        ? claim.payload.correlationId
        : undefined;
    const diagnostic = {
      event,
      eventId: claim.id,
      transactionId: claim.transactionId,
      walletId: claim.aggregateId,
      ...(correlationId ? { correlationId } : {}),
    };
    const providerId =
      isRecord(claim.payload) &&
      isRecord(claim.payload.data) &&
      typeof claim.payload.data.providerId === 'string'
        ? claim.payload.data.providerId
        : undefined;
    report(this.telemetry, { ...diagnostic, providerId });
    try {
      this.log(diagnostic);
    } catch {
      /* A committed publication cannot be undone by logging. */
    }
  }
}
