export type FinancialErrorCode =
  | 'INVALID_TRANSACTION_INPUT'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'UNKNOWN_PROVIDER'
  | 'UNSUPPORTED_TRANSACTION_CURRENCY'
  | 'UNSUPPORTED_WALLET_CURRENCY'
  | 'INVALID_WALLET_INPUT'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_ALREADY_EXISTS'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EXTERNAL_TRANSACTION_CONFLICT'
  | 'INFRASTRUCTURE_UNAVAILABLE'
  | 'INVALID_PERSISTED_TRANSACTION'
  | 'INBOX_PAYLOAD_CONFLICT'
  | 'INVALID_SQS_ENVELOPE'
  | 'INVALID_MESSAGE_GROUP'
  | 'TRANSACTION_NOT_FOUND'
  | 'INVALID_QUERY_INPUT'
  | 'INVALID_CURSOR'
  | 'INVALID_PERSISTED_DATA';

const messages: Record<FinancialErrorCode, string> = {
  INVALID_TRANSACTION_INPUT: 'Transaction input is invalid',
  INVALID_IDEMPOTENCY_KEY: 'Idempotency key is invalid',
  UNKNOWN_PROVIDER: 'Provider is not admitted',
  UNSUPPORTED_TRANSACTION_CURRENCY: 'Transaction currency is not supported',
  UNSUPPORTED_WALLET_CURRENCY: 'Wallet currency is not supported',
  INVALID_WALLET_INPUT: 'Wallet input is invalid',
  WALLET_NOT_FOUND: 'Wallet was not found',
  WALLET_ALREADY_EXISTS: 'Wallet already exists',
  IDEMPOTENCY_CONFLICT: 'Idempotency key conflicts with the original command',
  EXTERNAL_TRANSACTION_CONFLICT:
    'External transaction identity conflicts with the original command',
  INFRASTRUCTURE_UNAVAILABLE: 'Financial storage is temporarily unavailable',
  INVALID_PERSISTED_TRANSACTION: 'Persisted transaction is invalid',
  INBOX_PAYLOAD_CONFLICT: 'Inbox message content conflicts with its original delivery',
  INVALID_SQS_ENVELOPE: 'SQS envelope is invalid',
  INVALID_MESSAGE_GROUP: 'SQS message group does not match its wallet',
  TRANSACTION_NOT_FOUND: 'Transaction was not found',
  INVALID_QUERY_INPUT: 'Query input is invalid',
  INVALID_CURSOR: 'Ledger cursor is invalid',
  INVALID_PERSISTED_DATA: 'Persisted financial data is invalid',
};

export class FinancialError extends Error {
  constructor(
    readonly code: FinancialErrorCode,
    readonly details?: Readonly<{ walletId: string }>,
  ) {
    super(messages[code]);
    this.name = 'FinancialError';
  }
}

// Infrastructure translates only recognized database failures into this port-level error.
export class FinancialStorageError extends Error {
  constructor(
    readonly code:
      'IDENTITY_COLLISION' | 'WALLET_COLLISION' | 'TRANSIENT' | 'UNAVAILABLE' | 'WALLET_NOT_FOUND',
  ) {
    super('Financial storage operation could not complete');
    this.name = 'FinancialStorageError';
  }
}

// Only a recognized, persisted reference hydration failure is terminally classifiable.
// The unit of work may certify it only after an acknowledged rollback before COMMIT.
export class PermanentReferenceFailure extends Error {
  readonly code = 'INVALID_REFERENCE_STATE';
  constructor() {
    super('Persisted reference state is invalid');
    this.name = 'PermanentReferenceFailure';
  }
}
export class RolledBackFinancialFailure extends Error {
  constructor(readonly failure: PermanentReferenceFailure) {
    super('Financial attempt was rolled back');
    this.name = 'RolledBackFinancialFailure';
  }
}
