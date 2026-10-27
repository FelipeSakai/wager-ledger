import type { MoneyProps } from '../../domain/money/money';

export interface FinancialEventMetadata {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  occurredAt: Date;
}
export interface FinancialEventData {
  transactionId: string;
  walletId: string;
}
export interface ProcessedEventData extends FinancialEventData {
  playerId: string;
  origin: 'INTERNAL' | 'PROVIDER';
  kind: string;
  money: MoneyProps;
  balance: MoneyProps;
  processedAt: string;
  providerId?: string;
  externalTransactionId?: string;
}
export interface RejectedEventData extends FinancialEventData {
  origin: 'INTERNAL' | 'PROVIDER';
  kind: string;
  failureCode: string;
  rejectedAt: string;
}
export interface BalanceEventData extends FinancialEventData {
  direction: 'DEBIT' | 'CREDIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}
export interface PendingEventData extends FinancialEventData {
  providerId: string;
  referenceExternalTransactionId: string;
  reason: string;
  pendingAt: string;
}
export abstract class IntegrationEvent<T extends FinancialEventData> {
  readonly #metadata: FinancialEventMetadata;
  readonly #data: T;
  abstract readonly eventType: string;
  readonly version = 1;
  protected constructor(metadata: FinancialEventMetadata, data: T) {
    this.#metadata = { ...metadata, occurredAt: new Date(metadata.occurredAt) };
    this.#data = structuredClone(data);
  }
  toJSON() {
    return {
      eventId: this.#metadata.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.#metadata.aggregateId,
      correlationId: this.#metadata.correlationId,
      occurredAt: this.#metadata.occurredAt.toISOString(),
      data: structuredClone(this.#data),
    };
  }
}
export class WagerTransactionProcessed extends IntegrationEvent<ProcessedEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  private constructor(metadata: FinancialEventMetadata, data: ProcessedEventData) {
    super(metadata, data);
    Object.freeze(this);
  }
  static create(
    metadata: FinancialEventMetadata,
    data: ProcessedEventData,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed(metadata, data);
  }
}
export class WagerTransactionRejected extends IntegrationEvent<RejectedEventData> {
  readonly eventType = 'WagerTransactionRejected';
  private constructor(metadata: FinancialEventMetadata, data: RejectedEventData) {
    super(metadata, data);
    Object.freeze(this);
  }
  static create(
    metadata: FinancialEventMetadata,
    data: RejectedEventData,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected(metadata, data);
  }
}
export class WalletBalanceChanged extends IntegrationEvent<BalanceEventData> {
  readonly eventType = 'WalletBalanceChanged';
  private constructor(metadata: FinancialEventMetadata, data: BalanceEventData) {
    super(metadata, data);
    Object.freeze(this);
  }
  static create(metadata: FinancialEventMetadata, data: BalanceEventData): WalletBalanceChanged {
    return new WalletBalanceChanged(metadata, data);
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<PendingEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  private constructor(metadata: FinancialEventMetadata, data: PendingEventData) {
    super(metadata, data);
    Object.freeze(this);
  }
  static create(
    metadata: FinancialEventMetadata,
    data: PendingEventData,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(metadata, data);
  }
}
