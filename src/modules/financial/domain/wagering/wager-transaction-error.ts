export class WagerTransactionError extends Error {
  constructor(
    readonly code:
      | 'INVALID_TRANSACTION_STATE'
      | 'INVALID_PERSISTED_TRANSACTION'
      | 'INVALID_TRANSACTION_TRANSITION',
  ) {
    super('Transaction state is invalid');
    this.name = 'WagerTransactionError';
  }
}
