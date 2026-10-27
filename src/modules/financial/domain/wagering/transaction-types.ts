export type ExternalTransactionKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export type TransactionKind = 'OPENING' | ExternalTransactionKind;
export type TransactionStatus = WagerStatus;
