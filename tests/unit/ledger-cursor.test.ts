import { describe, expect, test } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';
import { HmacLedgerCursor } from '../../src/modules/financial/infrastructure/queries/hmac-ledger-cursor';
const secret = 'unit-fixture-cursor-key-at-least-32-bytes';
const walletId = randomUUID();
const cursor = { walletId, upperVersion: 50, lastVersion: 25 };
function signed(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
describe('HMAC ledger cursor', () => {
  test('QRY-015: survives codec recreation with a stable key and preserves the version cut', () => {
    const token = new HmacLedgerCursor(secret).encode(cursor);
    expect(new HmacLedgerCursor(secret).decode(token, walletId)).toEqual(cursor);
    expect(new HmacLedgerCursor(secret).decode(token, walletId.toUpperCase())).toEqual(cursor);
  });
  test('QRY-007: wallet binding, changed signature and key rotation are enforced', () => {
    const codec = new HmacLedgerCursor(secret);
    const token = codec.encode(cursor);
    for (const value of [
      token.slice(0, -2) + 'AB',
      token.replace(/^[A-Za-z]/, '9'),
      'x'.repeat(2049),
      'a.b',
      '',
      'a.b.c',
    ]) {
      expect(() => codec.decode(value, walletId)).toThrow(
        expect.objectContaining({ code: 'INVALID_CURSOR' }),
      );
    }
    expect(() => codec.decode(token, randomUUID())).toThrow();
    expect(() => new HmacLedgerCursor(secret + '-rotated').decode(token, walletId)).toThrow();
  });
  test.each([
    { ...cursor, v: 2 },
    { ...cursor, v: 1, upperVersion: 0 },
    { ...cursor, v: 1, lastVersion: 51 },
    { ...cursor, v: 1, lastVersion: 2.5 },
    { ...cursor, v: 1, upperVersion: '50' },
    { ...cursor, v: 1, upperVersion: 9007199254740992 },
    { ...cursor, v: 1, extra: true },
    null,
  ])('reject structurally invalid signed payload', (payload) => {
    expect(() => new HmacLedgerCursor(secret).decode(signed(payload), walletId)).toThrow(
      expect.objectContaining({ code: 'INVALID_CURSOR' }),
    );
  });
  test('rejects a signed array instead of an object', () => {
    expect(() => new HmacLedgerCursor(secret).decode(signed([]), walletId)).toThrow(
      expect.objectContaining({ code: 'INVALID_CURSOR' }),
    );
  });
  test('refuses an absent or weak signing key', () => {
    expect(() => new HmacLedgerCursor('')).toThrow();
    expect(() => new HmacLedgerCursor('short')).toThrow();
  });
});
