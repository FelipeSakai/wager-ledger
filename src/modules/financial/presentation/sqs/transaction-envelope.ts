import { FinancialError } from '../../application/financial-error';
import { validateTransactionInput } from '../../application/transactions/transaction-command';
import { isRecord } from '../../domain/validation/domain-validation';
export const envelopeMessageId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function canonicalJson(value: unknown): string {
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function transactionEnvelope(body: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new FinancialError('INVALID_SQS_ENVELOPE');
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).sort().join(',') !== 'data,messageId,occurredAt,type' ||
    !envelopeMessageId(parsed.messageId) ||
    parsed.type !== 'WagerTransactionRequested' ||
    typeof parsed.occurredAt !== 'string' ||
    !validIso(parsed.occurredAt) ||
    !isRecord(parsed.data)
  )
    throw new FinancialError('INVALID_SQS_ENVELOPE');
  const { idempotencyKey, ...input } = parsed.data;
  const validated = validateTransactionInput(input, idempotencyKey);
  return {
    messageId: parsed.messageId,
    input,
    key: validated.key,
    walletId: validated.command.walletId,
    canonical: canonicalJson(parsed),
  };
}
function validIso(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return (
    date.toISOString().slice(0, 10) === value.slice(0, 10) &&
    Number(match[4]) < 24 &&
    Number(match[5]) < 60 &&
    Number(match[6]) < 60 &&
    (match[7] === undefined || (Number(match[7]) < 24 && Number(match[8]) < 60))
  );
}
