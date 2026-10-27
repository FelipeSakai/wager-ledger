const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

export function isTimestamp(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function isWalletVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
