export type WalletErrorCode =
  | 'INVALID_WALLET_INPUT'
  | 'INVALID_MOVEMENT_AMOUNT'
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_LEDGER_ENTRY'
  | 'INVALID_PERSISTED_WALLET'
  | 'INVALID_PERSISTED_LEDGER_ENTRY';

const messages: Record<WalletErrorCode, string> = {
  INVALID_WALLET_INPUT: 'Wallet identity, initial balance or timestamp is invalid',
  INVALID_MOVEMENT_AMOUNT: 'A wallet movement requires strictly positive money',
  INSUFFICIENT_FUNDS: 'Wallet balance is insufficient for this debit',
  INVALID_LEDGER_ENTRY: 'Ledger identity, version, timestamp or financial transition is invalid',
  INVALID_PERSISTED_WALLET: 'Persisted wallet has an invalid representation',
  INVALID_PERSISTED_LEDGER_ENTRY: 'Persisted ledger entry has an invalid representation',
};

export class WalletError extends Error {
  override readonly name = 'WalletError';

  constructor(readonly code: WalletErrorCode) {
    super(messages[code]);
  }
}
