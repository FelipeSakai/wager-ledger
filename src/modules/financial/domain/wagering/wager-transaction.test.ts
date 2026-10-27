import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../money/money';
import { Wallet } from '../wallet/wallet';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { type WagerCommand, type WagerState } from './wager-state';
import { WagerTransaction } from './wager-transaction';

const at = () => new Date('2026-10-27T18:00:00.000Z');
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
const wallet = (amount = '100.00') =>
  Wallet.open({
    id: randomUUID(),
    playerId: randomUUID(),
    initialBalance: money(amount),
    at: at(),
  });
function transaction(
  w: Wallet,
  kind: WagerCommand['kind'] = 'BET',
  amount = '25.00',
  extra: Partial<WagerCommand> = {},
) {
  return WagerTransaction.create({
    id: randomUUID(),
    command: {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: money(amount),
      ...extra,
    },
    idempotencyKey: randomUUID(),
    payloadHash: 'a'.repeat(64),
    payloadHashVersion: 1,
    createdAt: at(),
  });
}
function apply(
  t: WagerTransaction,
  w: Wallet,
  reference?: WagerState,
  extra: Record<string, unknown> = {},
) {
  return t.apply(w, {
    at: at(),
    ledgerEntryId: randomUUID(),
    reference,
    alreadyReversed: false,
    nextReferenceAttemptAt: new Date(at().getTime() + 2500),
    referenceExpiresAt: new Date(at().getTime() + 86400000),
    ...extra,
  });
}
function reference(w: Wallet, kind: WagerCommand['kind'] = 'BET') {
  const tx = transaction(
    w,
    kind,
    '25.00',
    kind === 'REFUND' ? { referenceExternalTransactionId: 'bet' } : {},
  );
  const state = tx.snapshot();
  return {
    ...state,
    status: 'PROCESSED' as const,
    processedAt: at(),
    completedAt: at(),
    result: {
      transactionId: state.id,
      status: 'PROCESSED' as const,
      balance: money('75.00').toJSON(),
    },
  };
}

describe('WagerTransaction domain', () => {
  test.each([
    ['BET', LedgerDirection.Debit, '75.00'],
    ['WIN', LedgerDirection.Credit, '125.00'],
  ] as const)('PROC-001/002: %s moves money once', (kind, direction, amount) => {
    const w = wallet();
    const tx = transaction(w, kind);
    const entry = apply(tx, w);
    expect(entry?.direction).toBe(direction);
    expect(w.balance.toJSON().amount).toBe(amount);
    expect(tx.snapshot().status).toBe('PROCESSED');
    expect(() => apply(tx, w)).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSACTION_TRANSITION' }),
    );
  });
  test('snapshot copies command, result and dates defensively', () => {
    const w = wallet();
    const tx = transaction(w);
    apply(tx, w);
    const snapshot = tx.snapshot();
    snapshot.command.playerId = randomUUID();
    snapshot.createdAt.setTime(0);
    snapshot.result!.balance.amount = '0.00';
    snapshot.completedAt!.setTime(0);
    expect(tx.snapshot().command.playerId).toBe(w.playerId);
    expect(tx.snapshot().createdAt).toEqual(at());
    expect(tx.snapshot().result!.balance.amount).toBe('75.00');
    expect(tx.snapshot().completedAt).toEqual(at());
    const reconstructed = WagerTransaction.rehydrate(tx.snapshot());
    expect(() => apply(reconstructed, w)).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSACTION_TRANSITION' }),
    );
  });
  test.each([
    ['providerId', 'provider-b'],
    ['playerId', '00000000-0000-4000-8000-000000000001'],
    ['walletId', '00000000-0000-4000-8000-000000000002'],
    ['roundId', 'another-round'],
  ] as const)('REV-006: reference %s mismatch rejects without mutation', (field, value) => {
    const w = wallet();
    const ref = reference(w);
    ref.command[field] = value;
    const tx = transaction(w, 'REFUND', '25.00', {
      referenceExternalTransactionId: ref.command.externalTransactionId,
    });
    expect(apply(tx, w, ref)).toBeUndefined();
    expect(tx.snapshot().result?.failureCode).toBe('REFERENCE_CONTEXT_MISMATCH');
    expect(w.balance.toJSON().amount).toBe('100.00');
    expect(w.version).toBe(1);
  });
  test.each(['10.00', '26.00'])(
    'REV-006: reversal amount %s must equal the reference',
    (amount) => {
      const w = wallet();
      const ref = reference(w);
      const tx = transaction(w, 'REFUND', amount, {
        referenceExternalTransactionId: ref.command.externalTransactionId,
      });
      apply(tx, w, ref);
      expect(tx.snapshot().result?.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    },
  );
  test('REV-018/019: WIN amount may differ and LOSS stays zero even when referencing BET', () => {
    const w = wallet();
    const ref = reference(w);
    const win = transaction(w, 'WIN', '10.00', {
      referenceExternalTransactionId: ref.command.externalTransactionId,
      gameId: 'another-game',
    });
    apply(win, w, ref);
    expect(win.snapshot().status).toBe('PROCESSED');
    expect(w.balance.toJSON().amount).toBe('110.00');
    const loss = transaction(w, 'LOSS', '0.00', {
      referenceExternalTransactionId: ref.command.externalTransactionId,
    });
    expect(apply(loss, w, ref)).toBeUndefined();
    expect(loss.snapshot().status).toBe('PROCESSED');
    expect(w.version).toBe(2);
  });
  test.each(['WIN', 'REFUND', 'ROLLBACK', 'LOSS'] as const)(
    'REV-008: REFUND cannot refer to %s',
    (kind) => {
      const w = wallet();
      const ref = reference(w);
      ref.command.kind = kind;
      const tx = transaction(w, 'REFUND', '25.00', {
        referenceExternalTransactionId: ref.command.externalTransactionId,
      });
      apply(tx, w, ref);
      expect(tx.snapshot().result?.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
    },
  );
  test.each(['REJECTED', 'FAILED'] as const)(
    'REV-008: %s reference rejects instead of waiting',
    (status) => {
      const w = wallet();
      const ref = reference(w);
      ref.status = status as 'PROCESSED';
      const tx = transaction(w, 'REFUND', '25.00', {
        referenceExternalTransactionId: ref.command.externalTransactionId,
      });
      apply(tx, w, ref);
      expect(tx.snapshot().result?.failureCode).toBe('REFERENCE_NOT_PROCESSED');
    },
  );
  test('self reference is terminal and does not become a pending cycle', () => {
    const w = wallet();
    const tx = transaction(w, 'WIN', '10.00', {
      externalTransactionId: 'self',
      referenceExternalTransactionId: 'self',
    });
    apply(tx, w);
    expect(tx.snapshot().result?.failureCode).toBe('REFERENCE_SELF_REFERENCE');
  });
  test('REV-010: missing reference waits and expires at its durable deadline', () => {
    const w = wallet();
    const tx = transaction(w, 'REFUND', '25.00', { referenceExternalTransactionId: 'missing' });
    apply(tx, w);
    const state = tx.snapshot();
    expect(state.referenceAttempts).toBe(1);
    expect(state.pendingReason).toBe('REFERENCE_NOT_FOUND');
    const copy = WagerTransaction.rehydrate(state);
    apply(copy, w, undefined, { at: state.referenceExpiresAt });
    expect(copy.snapshot().result?.failureCode).toBe('REFERENCE_NOT_FOUND_EXPIRED');
    expect(w.version).toBe(1);
  });
  test('limit of reference checks is enforced even before deadline', () => {
    const w = wallet();
    const tx = transaction(w, 'WIN', '25.00', { referenceExternalTransactionId: 'missing' });
    apply(tx, w);
    const copy = WagerTransaction.rehydrate({ ...tx.snapshot(), referenceAttempts: 1000 });
    apply(copy, w);
    expect(copy.snapshot().result?.failureCode).toBe('REFERENCE_NOT_FOUND_EXPIRED');
  });
  test('an available reference wins over an elapsed deadline', () => {
    const w = wallet();
    const ref = reference(w);
    const tx = transaction(w, 'REFUND', '25.00', {
      referenceExternalTransactionId: ref.command.externalTransactionId,
    });
    apply(tx, w);
    const pending = WagerTransaction.rehydrate(tx.snapshot());
    apply(pending, w, ref, { at: new Date(at().getTime() + 86400000) });
    expect(pending.snapshot().status).toBe('PROCESSED');
    expect(w.balance.toJSON().amount).toBe('125.00');
  });
  test('REV-D01: another effective reversal prevents a second movement', () => {
    const w = wallet();
    const ref = reference(w);
    const tx = transaction(w, 'ROLLBACK', '25.00', {
      referenceExternalTransactionId: ref.command.externalTransactionId,
    });
    expect(apply(tx, w, ref, { alreadyReversed: true })).toBeUndefined();
    expect(tx.snapshot().result?.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(w.version).toBe(1);
  });
  test.each([null, {}, { status: 'PENDING' }, { command: {} }])(
    'persisted corruption uses a stable error',
    (invalid) => {
      expect(() => WagerTransaction.rehydrate(invalid as unknown as WagerState)).toThrow(
        expect.objectContaining({ code: 'INVALID_PERSISTED_TRANSACTION' }),
      );
    },
  );
  test.each(['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'] as const)(
    'persisted %s result must retain the command currency',
    (status) => {
      const w = wallet();
      const pending = status === 'PENDING_REFERENCE' || status === 'FAILED';
      const tx = pending
        ? transaction(w, 'REFUND', '25.00', { referenceExternalTransactionId: 'missing' })
        : transaction(w, 'BET', status === 'REJECTED' ? '150.00' : '25.00');
      apply(tx, w);
      if (status === 'FAILED') tx.failReference(w, at());
      const state = tx.snapshot();
      expect(state.status).toBe(status);
      expect(WagerTransaction.rehydrate(state).snapshot()).toEqual(state);
      state.result!.balance.currency = 'USD';
      expect(() => WagerTransaction.rehydrate(state)).toThrow(
        expect.objectContaining({ code: 'INVALID_PERSISTED_TRANSACTION' }),
      );
    },
  );
  test.each([false, true])(
    'early wallet context rejection retains actual wallet currency (player mismatch: %s)',
    (playerMismatch) => {
      const w = wallet();
      const tx = transaction(w, 'BET', '25.00', {
        money: Money.from({ amount: '25.00', currency: 'USD' }),
        ...(playerMismatch ? { playerId: randomUUID() } : {}),
      });
      apply(tx, w);
      const state = tx.snapshot();
      expect(state.result).toMatchObject({
        status: 'REJECTED',
        failureCode: playerMismatch ? 'WALLET_PLAYER_MISMATCH' : 'CURRENCY_MISMATCH',
        balance: { amount: '100.00', currency: 'BRL' },
      });
      expect(WagerTransaction.rehydrate(state).snapshot()).toEqual(state);
      expect(w.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(w.version).toBe(1);
      if (!playerMismatch) {
        state.result!.balance.currency = 'USD';
        expect(() => WagerTransaction.rehydrate(state)).toThrow(
          expect.objectContaining({ code: 'INVALID_PERSISTED_TRANSACTION' }),
        );
      }
    },
  );
  test('result corruption and an invalid terminal balance cannot be rehydrated', () => {
    const w = wallet();
    const tx = transaction(w);
    apply(tx, w);
    const state = tx.snapshot();
    for (const result of [
      { ...state.result!, status: 'REJECTED' },
      { ...state.result!, balance: { amount: '-1.00', currency: 'BRL' } },
      { ...state.result!, transactionId: randomUUID() },
    ]) {
      expect(() => WagerTransaction.rehydrate({ ...state, result } as WagerState)).toThrow(
        expect.objectContaining({ code: 'INVALID_PERSISTED_TRANSACTION' }),
      );
    }
  });
});

test('classified pending failure is terminal, preserves wallet and snapshot dates', () => {
  const w = wallet();
  const tx = transaction(w, 'REFUND', '25.00', { referenceExternalTransactionId: 'missing' });
  apply(tx, w);
  const before = tx.snapshot();
  const date = at();
  tx.failReference(w, date);
  date.setTime(0);
  expect(tx.snapshot()).toMatchObject({
    status: 'FAILED',
    referenceAttempts: 1,
    completedAt: at(),
    result: {
      status: 'FAILED',
      failureCode: 'INVALID_REFERENCE_STATE',
      balance: { amount: '100.00' },
    },
  });
  expect(tx.snapshot().nextReferenceAttemptAt).toBeUndefined();
  expect(tx.snapshot().referenceExpiresAt).toEqual(before.referenceExpiresAt);
  expect(w.version).toBe(1);
  expect(w.balance.toJSON().amount).toBe('100.00');
  const rehydrated = WagerTransaction.rehydrate(tx.snapshot());
  expect(() => rehydrated.failReference(w, at())).toThrow(
    expect.objectContaining({ code: 'INVALID_TRANSACTION_TRANSITION' }),
  );
  expect(() => apply(rehydrated, w)).toThrow(
    expect.objectContaining({ code: 'INVALID_TRANSACTION_TRANSITION' }),
  );
});
test('failure transition refuses a new reservation, another wallet and invalid dates without mutation', () => {
  const w = wallet();
  const tx = transaction(w, 'REFUND', '25.00', { referenceExternalTransactionId: 'missing' });
  expect(() => tx.failReference(w, at())).toThrow();
  apply(tx, w);
  const original = tx.snapshot();
  expect(() => tx.failReference(wallet(), at())).toThrow();
  expect(() => tx.failReference(w, new Date(NaN))).toThrow();
  expect(tx.snapshot()).toEqual(original);
});
