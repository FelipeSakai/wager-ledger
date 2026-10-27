import { randomUUID } from 'node:crypto';
import type { FinancialOperationContext } from '../../application/ports/financial-telemetry';
import {
  report,
  silentTelemetry,
  type FinancialTelemetry,
} from '../../application/ports/financial-telemetry';
import type { QueueDelivery, SqsTransport } from '../../application/ports/queue-transport';
import type { DispatchDlq } from '../../application/use-cases/dispatch-dlq';
import type { HandleSqsDelivery } from './handle-sqs-delivery';
export interface SqsConsumerOptions {
  batchSize: number;
  waitSeconds: number;
  visibilitySeconds: number;
  heartbeatMilliseconds: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}
export const defaultSqsConsumerOptions: SqsConsumerOptions = {
  batchSize: 10,
  waitSeconds: 20,
  visibilitySeconds: 60,
  heartbeatMilliseconds: 20000,
  retryBaseSeconds: 1,
  retryMaxSeconds: 30,
};
export class SqsConsumer {
  private stopping = false;
  private readonly receiveAbort = new AbortController();
  constructor(
    private readonly transport: SqsTransport,
    private readonly handler: Pick<HandleSqsDelivery, 'execute'>,
    private readonly dispatcher: Pick<DispatchDlq, 'execute'>,
    private readonly options: SqsConsumerOptions = defaultSqsConsumerOptions,
    private readonly log: (event: string, context?: FinancialOperationContext) => void = (event) =>
      console.error(JSON.stringify({ level: 'error', event })),
    private readonly telemetry: FinancialTelemetry = silentTelemetry,
  ) {
    if (
      !Number.isInteger(options.batchSize) ||
      options.batchSize < 1 ||
      options.batchSize > 10 ||
      !Number.isInteger(options.waitSeconds) ||
      options.waitSeconds < 0 ||
      options.waitSeconds > 20 ||
      !Number.isInteger(options.visibilitySeconds) ||
      options.visibilitySeconds < 1 ||
      options.visibilitySeconds > 43200 ||
      !Number.isSafeInteger(options.heartbeatMilliseconds) ||
      options.retryBaseSeconds < 1 ||
      options.retryMaxSeconds < options.retryBaseSeconds ||
      options.retryMaxSeconds > 43200 ||
      options.heartbeatMilliseconds < 1 ||
      options.heartbeatMilliseconds >= options.visibilitySeconds * 1000
    )
      throw new Error('SQS consumer options are invalid');
  }
  stop(): void {
    this.stopping = true;
    this.receiveAbort.abort();
  }
  async pollOnce(): Promise<number> {
    if (this.stopping) return 0;
    let messages: QueueDelivery[];
    try {
      messages = await this.transport.receive(
        this.options.batchSize,
        this.options.waitSeconds,
        this.options.visibilitySeconds,
        this.receiveAbort.signal,
      );
    } catch (error) {
      if (this.stopping) return 0;
      throw error;
    }
    const groups = new Map<string, QueueDelivery[]>();
    const contexts = new Map(
      messages.map((message) => [
        message.receiptHandle,
        { correlationId: randomUUID(), walletId: message.groupId } as FinancialOperationContext,
      ]),
    );
    const timers = new Map<string, ReturnType<typeof setInterval>>();
    const renewing = new Map<string, Promise<void>>();
    for (const message of messages) {
      const group = groups.get(message.groupId) ?? [];
      group.push(message);
      groups.set(message.groupId, group);
      timers.set(
        message.receiptHandle,
        setInterval(() => {
          if (renewing.has(message.receiptHandle)) return;
          const work = this.transport
            .visibility(message.receiptHandle, this.options.visibilitySeconds)
            .catch(() =>
              this.log('sqs_visibility_renewal_failed', contexts.get(message.receiptHandle)),
            )
            .finally(() => renewing.delete(message.receiptHandle));
          renewing.set(message.receiptHandle, work);
        }, this.options.heartbeatMilliseconds),
      );
    }
    const stopHeartbeat = async (message: QueueDelivery) => {
      clearInterval(timers.get(message.receiptHandle));
      await renewing.get(message.receiptHandle);
    };
    await Promise.all(
      [...groups.values()].map(async (group) => {
        let blocked = false;
        for (const message of group) {
          const context = contexts.get(message.receiptHandle)!;
          try {
            if (this.stopping || blocked) {
              await stopHeartbeat(message);
              await this.transport.visibility(message.receiptHandle, 0);
              continue;
            }
            const disposition = await this.handler.execute(message, context);
            const acknowledged =
              disposition.acknowledge ||
              Boolean(
                disposition.transferId && (await this.dispatcher.execute(disposition.transferId)),
              );
            await stopHeartbeat(message);
            if (acknowledged) {
              await this.transport.acknowledge(message.receiptHandle);
              report(this.telemetry, {
                event: 'sqs_delivery',
                ...context,
                outcome: 'acknowledged',
              });
            } else {
              blocked = true;
              await this.retry(message, context);
            }
          } catch {
            blocked = true;
            await stopHeartbeat(message);
            this.log('sqs_delivery_incomplete', context);
            try {
              await this.retry(message, context);
            } catch {
              this.log('sqs_visibility_update_failed', context);
            }
          } finally {
            await stopHeartbeat(message);
          }
        }
      }),
    );
    return messages.length;
  }
  private retry(message: QueueDelivery, context: FinancialOperationContext): Promise<void> {
    if (this.stopping) return this.transport.visibility(message.receiptHandle, 0);
    report(this.telemetry, {
      event: 'financial_retry',
      component: 'sqs',
      cause: 'unavailable',
      ...context,
    });
    const maximum = Math.min(
      this.options.retryMaxSeconds,
      this.options.retryBaseSeconds * 2 ** Math.min(message.receiveCount - 1, 20),
    );
    return this.transport.visibility(
      message.receiptHandle,
      Math.max(1, Math.ceil(maximum * (0.5 + Math.random() * 0.5))),
    );
  }
}
