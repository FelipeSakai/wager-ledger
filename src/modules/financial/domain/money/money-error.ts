export type MoneyErrorCode =
  | 'INVALID_MONEY_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'CURRENCY_MISMATCH'
  | 'MONEY_OUT_OF_RANGE'
  | 'INVALID_PERSISTED_MONEY';

const messages: Record<MoneyErrorCode, string> = {
  INVALID_MONEY_AMOUNT:
    'Amount must be a non-negative canonical decimal string with two decimal places',
  INVALID_CURRENCY: 'Currency must be BRL or USD',
  CURRENCY_MISMATCH: 'Money operands must have the same currency',
  MONEY_OUT_OF_RANGE: 'Money exceeds the supported range',
  INVALID_PERSISTED_MONEY: 'Persisted money has an invalid representation',
};

export class MoneyError extends Error {
  override readonly name = 'MoneyError';

  constructor(readonly code: MoneyErrorCode) {
    super(messages[code]);
  }
}
