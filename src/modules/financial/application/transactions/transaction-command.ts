import { Money } from '../../domain/money/money';
import { isRecord, isUuid } from '../../domain/validation/domain-validation';
import type { ExternalTransactionKind } from '../../domain/wagering/transaction-types';
import type { WagerCommand } from '../../domain/wagering/wager-state';
import { FinancialError } from '../financial-error';

const fields = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
];
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  value.trim() === value;

export function validateTransactionInput(
  input: unknown,
  key: unknown,
): { command: WagerCommand; key: string } {
  if (!text(key, 255)) throw new FinancialError('INVALID_IDEMPOTENCY_KEY');
  if (
    !isRecord(input) ||
    Object.keys(input).some((field) => !fields.includes(field)) ||
    !text(input.providerId, 64) ||
    !/^[A-Za-z0-9_-]+$/.test(input.providerId) ||
    !text(input.externalTransactionId, 128) ||
    !isUuid(input.playerId) ||
    !isUuid(input.walletId) ||
    !text(input.roundId, 128) ||
    !text(input.gameId, 128) ||
    typeof input.kind !== 'string' ||
    !['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(input.kind) ||
    !isRecord(input.money) ||
    Object.keys(input.money).some((field) => !['amount', 'currency'].includes(field)) ||
    (Object.hasOwn(input, 'referenceExternalTransactionId') &&
      !text(input.referenceExternalTransactionId, 128)) ||
    (input.kind === 'BET' && Object.hasOwn(input, 'referenceExternalTransactionId')) ||
    (['REFUND', 'ROLLBACK'].includes(input.kind) &&
      !Object.hasOwn(input, 'referenceExternalTransactionId'))
  ) {
    throw new FinancialError('INVALID_TRANSACTION_INPUT');
  }
  const money = Money.from({
    amount: input.money.amount as string,
    currency: input.money.currency as string,
  });
  if (money.currency !== 'BRL') throw new FinancialError('UNSUPPORTED_TRANSACTION_CURRENCY');
  return {
    key,
    command: {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind as ExternalTransactionKind,
      money,
      ...(typeof input.referenceExternalTransactionId === 'string'
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
        : {}),
    },
  };
}

// SHA-256/JSON-v1: explicit recursively sorted keys, UTF-8 supplied by the hashing port.
export function canonicalTransaction(command: WagerCommand): string {
  return JSON.stringify({
    externalTransactionId: command.externalTransactionId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money.toJSON(),
    playerId: command.playerId,
    providerId: command.providerId,
    referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
    roundId: command.roundId,
    walletId: command.walletId,
  });
}
