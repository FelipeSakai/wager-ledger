import { createHmac, timingSafeEqual } from 'node:crypto';
import { FinancialError } from '../../application/financial-error';
import type { LedgerCursor, LedgerCursorPort } from '../../application/ports/financial-read-store';
import { isRecord, isUuid, isWalletVersion } from '../../domain/validation/domain-validation';

export class HmacLedgerCursor implements LedgerCursorPort {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret, 'utf8') < 32)
      throw new Error('LEDGER_CURSOR_SECRET must contain at least 32 bytes');
  }
  encode(cursor: LedgerCursor): string {
    const payload = Buffer.from(JSON.stringify({ v: 1, ...cursor })).toString('base64url');
    return `${payload}.${this.sign(payload).toString('base64url')}`;
  }
  decode(value: string, walletId: string): LedgerCursor {
    const invalid = () => {
      throw new FinancialError('INVALID_CURSOR');
    };
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return invalid();
    const [payload, signature] = value.split('.');
    if (!payload || !signature) return invalid();
    const received = Buffer.from(signature, 'base64url');
    const expected = this.sign(payload);
    if (
      received.length !== expected.length ||
      received.toString('base64url') !== signature ||
      !timingSafeEqual(received, expected)
    )
      return invalid();
    let decoded: unknown;
    try {
      const bytes = Buffer.from(payload, 'base64url');
      if (bytes.toString('base64url') !== payload) return invalid();
      decoded = JSON.parse(bytes.toString('utf8'));
    } catch {
      return invalid();
    }
    if (
      !isRecord(decoded) ||
      Object.keys(decoded).sort().join(',') !== 'lastVersion,upperVersion,v,walletId' ||
      decoded.v !== 1 ||
      !isUuid(decoded.walletId) ||
      decoded.walletId.toLowerCase() !== walletId.toLowerCase() ||
      !isWalletVersion(decoded.upperVersion) ||
      !isWalletVersion(decoded.lastVersion) ||
      decoded.lastVersion > decoded.upperVersion
    )
      return invalid();
    return {
      walletId: decoded.walletId,
      upperVersion: decoded.upperVersion,
      lastVersion: decoded.lastVersion,
    };
  }
  private sign(payload: string): Buffer {
    return createHmac('sha256', this.secret).update(payload, 'utf8').digest();
  }
}
