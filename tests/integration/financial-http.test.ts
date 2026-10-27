import { ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createHttpApplication } from '../../src/bootstrap/http-application';
import {
  ProviderIdentityPort,
  type ProviderAccessContext,
} from '../../src/modules/financial/application/ports/provider-identity';
import { FinancialQueryDiagnostics } from '../../src/modules/financial/infrastructure/observability/query-diagnostics';
import { financialTestDatabase } from '../support/financial-test-database';

let db: Awaited<ReturnType<typeof financialTestDatabase>>;
let app: Awaited<ReturnType<typeof createHttpApplication>>;
let base: string;
const logs: unknown[] = [];
const diagnostics = new FinancialQueryDiagnostics((value) => logs.push(value));
const identityCalls: ProviderAccessContext[] = [];
class ObservedDeferredIdentity extends ProviderIdentityPort {
  async authorize(context: ProviderAccessContext): Promise<void> {
    identityCalls.push(context);
  }
}
async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, options);
  const body = (await response.json()) as Record<string, any>;
  return { response, body };
}
const post = (path: string, input: unknown, headers: Record<string, string> = {}) =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(input),
  });
async function open(amount = '100.00') {
  const playerId = randomUUID();
  const result = await post('/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  expect(result.response.status).toBe(201);
  return result.body as {
    id: string;
    playerId: string;
    balance: { amount: string; currency: string };
    version: number;
  };
}
function transaction(
  wallet: { id: string; playerId: string },
  kind = 'BET',
  amount = '25.00',
  extra: Record<string, unknown> = {},
) {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}
const submit = (input: unknown, key = randomUUID(), correlationId = randomUUID()) =>
  post('/wagering/transactions', input, {
    'Idempotency-Key': key,
    'X-Correlation-Id': correlationId,
  });
async function reconciled(id: string, expected: string) {
  const { response, body } = await post(`/wallets/${id}/reconciliation`, {});
  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    storedBalance: { amount: expected, currency: 'BRL' },
    calculatedBalance: { amount: expected, currency: 'BRL' },
    difference: { amount: '0.00', currency: 'BRL' },
    consistent: true,
  });
}
beforeAll(async () => {
  db = await financialTestDatabase();
  app = await createHttpApplication({
    databaseUrl: db.url,
    cursorSecret: 'http-fixture-signing-key-32-bytes-or-more',
    providers: ['provider-a', 'provider-b'],
    diagnostics,
    identity: new ObservedDeferredIdentity(),
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 30000);
afterAll(async () => {
  if (app) await app.close();
  if (db) await db.close();
}, 30000);

describe('Financial HTTP — real NestJS, TCP and PostgreSQL', () => {
  test('POST /wallets returns 201; GET shows exact current money and UTC dates', async () => {
    const wallet = await open();
    const { response, body } = await request(`/wallets/${wallet.id}`);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ...wallet, version: 1 });
    expect(body.createdAt).toMatch(/Z$/);
    expect(body.updatedAt).toBe(body.createdAt);
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    await reconciled(wallet.id, '100.00');
  });
  test('WAL-041/QRY-016: duplicate opening recovers the wallet after its balance changes', async () => {
    const wallet = await open();
    await submit(transaction(wallet));
    const duplicate = await post('/wallets', {
      playerId: wallet.playerId,
      initialBalance: { amount: '250.00', currency: 'BRL' },
    });
    expect(duplicate.response.status).toBe(409);
    expect(duplicate.body.error).toMatchObject({
      code: 'WALLET_ALREADY_EXISTS',
      details: { walletId: wallet.id },
    });
    const current = await request(`/wallets/${duplicate.body.error.details.walletId}`);
    expect(current.body.balance.amount).toBe('75.00');
    expect(current.body.version).toBe(2);
    await reconciled(wallet.id, '75.00');
  });
  test('submission and historical replay use 200 and omit the internal HTTP status', async () => {
    const wallet = await open();
    const input = transaction(wallet);
    const key = randomUUID();
    const correlation = randomUUID();
    const first = await submit(input, key, correlation);
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00' },
      idempotentReplay: false,
      correlationId: correlation,
    });
    expect(first.body).not.toHaveProperty('httpStatus');
    expect(first.response.headers.get('x-correlation-id')).toBe(correlation);
    await submit(transaction(wallet, 'WIN', '10.00'));
    const replay = await submit(input, key);
    expect(replay.response.status).toBe(200);
    expect(replay.body).toMatchObject({
      transactionId: first.body.transactionId,
      balance: { amount: '75.00' },
      idempotentReplay: true,
    });
    const byId = await request(`/wagering/transactions/${first.body.transactionId}`);
    const external = await request(
      `/providers/provider-a/wagering/transactions/${input.externalTransactionId}`,
    );
    expect(byId.response.status).toBe(200);
    expect(external.body).toEqual(byId.body);
    expect(byId.body.result.balance.amount).toBe('75.00');
    expect(byId.body).not.toHaveProperty('idempotentReplay');
    for (const hidden of [
      'idempotencyKey',
      'payloadHash',
      'payloadHashVersion',
      'internalIdentity',
      'claimToken',
      'httpStatus',
    ])
      expect(byId.body).not.toHaveProperty(hidden);
    await reconciled(wallet.id, '85.00');
  });
  test('rejection uses 422 on submission/replay and 200 when queried', async () => {
    const wallet = await open();
    const input = transaction(wallet, 'BET', '150.00');
    const key = randomUUID();
    const first = await submit(input, key);
    expect(first.response.status).toBe(422);
    expect(first.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '100.00' },
    });
    expect((await submit(input, key)).response.status).toBe(422);
    const lookup = await request(`/wagering/transactions/${first.body.transactionId}`);
    expect(lookup.response.status).toBe(200);
    expect(lookup.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    await reconciled(wallet.id, '100.00');
  });
  test('pending reference uses 202 and queries return its state without applying it', async () => {
    const wallet = await open();
    const input = transaction(wallet, 'REFUND', '25.00', {
      referenceExternalTransactionId: randomUUID(),
    });
    const key = randomUUID();
    const pending = await submit(input, key);
    expect(pending.response.status).toBe(202);
    expect((await submit(input, key)).body).toMatchObject({
      transactionId: pending.body.transactionId,
      status: 'PENDING_REFERENCE',
      idempotentReplay: true,
    });
    const found = await request(`/wagering/transactions/${pending.body.transactionId}`);
    expect(found.response.status).toBe(200);
    expect(found.body.status).toBe('PENDING_REFERENCE');
    await reconciled(wallet.id, '100.00');
  });
  test('key and external identity conflicts use 409 with no SQL details', async () => {
    const wallet = await open();
    const input = transaction(wallet);
    const key = randomUUID();
    await submit(input, key);
    const conflict = await submit({ ...input, walletId: randomUUID() }, key);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await submit(input)).body.error.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
    expect(JSON.stringify(conflict.body)).not.toMatch(
      /SELECT|INSERT|constraint|stack|postgresql|password/,
    );
    await reconciled(wallet.id, '75.00');
  });
  test('OPENING is available by internal transaction ID without a provider identity', async () => {
    const wallet = await open();
    const ledger = await request(`/wallets/${wallet.id}/ledger`);
    const id = ledger.body.items[0].transactionId;
    const { response, body } = await request(`/wagering/transactions/${id}`);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ kind: 'OPENING', origin: 'INTERNAL', status: 'PROCESSED' });
    expect(body).not.toHaveProperty('providerId');
    expect(body).not.toHaveProperty('externalTransactionId');
    await reconciled(wallet.id, '100.00');
  });
  test('zero opening has an empty ledger and exact zero reconciliation', async () => {
    const wallet = await open('0.00');
    expect((await request(`/wallets/${wallet.id}/ledger`)).body).toEqual({ items: [] });
    await reconciled(wallet.id, '0.00');
  });
  test('QRY-005/006: signed cursor preserves the initial version while new entries arrive', async () => {
    const wallet = await open();
    for (let i = 0; i < 4; i++) await submit(transaction(wallet, 'WIN', '1.00'));
    const first = await request(`/wallets/${wallet.id}/ledger?limit=2`);
    expect(first.body.items.map((item: any) => item.walletVersion)).toEqual([5, 4]);
    expect(first.body.nextCursor).toBeString();
    await submit(transaction(wallet, 'WIN', '1.00'));
    const second = await request(
      `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items.map((item: any) => item.walletVersion)).toEqual([3, 2]);
    const last = await request(
      `/wallets/${wallet.id}/ledger?limit=2&cursor=${second.body.nextCursor}`,
    );
    expect(last.body.items.map((item: any) => item.walletVersion)).toEqual([1]);
    expect(last.body).not.toHaveProperty('nextCursor');
    expect(
      (await request(`/wallets/${wallet.id}/ledger?limit=1`)).body.items[0].walletVersion,
    ).toBe(6);
    const another = await open();
    const cross = await request(`/wallets/${another.id}/ledger?cursor=${first.body.nextCursor}`);
    expect(cross.response.status).toBe(400);
    expect(cross.body.error.code).toBe('INVALID_CURSOR');
    await reconciled(wallet.id, '105.00');
    await reconciled(another.id, '100.00');
  });
  test.each(['0', '-1', '1.5', '101', '1e2', '01', '', '1&limit=2'])(
    'invalid ledger limit %s returns 400',
    async (limit) => {
      const wallet = await open('0.00');
      const result = await request(`/wallets/${wallet.id}/ledger?limit=${limit}`);
      expect(result.response.status).toBe(400);
      expect(result.body.error.code).toBe('INVALID_QUERY_INPUT');
      await reconciled(wallet.id, '0.00');
    },
  );
  test('malformed IDs and missing resources use 400 and 404 distinctly', async () => {
    expect((await request('/wallets/not-a-uuid')).response.status).toBe(400);
    expect((await request(`/wallets/${randomUUID()}`)).response.status).toBe(404);
    expect((await request(`/wagering/transactions/${randomUUID()}`)).body.error.code).toBe(
      'TRANSACTION_NOT_FOUND',
    );
    expect(
      (await request('/providers/provider-a/wagering/transactions/missing')).response.status,
    ).toBe(404);
    expect((await request('/nonexistent')).response.status).toBe(404);
  });
  test('money, internal fields and missing idempotency key are rejected before any financial effect', async () => {
    const wallet = await open();
    for (const extra of [
      { money: { amount: 25, currency: 'BRL' } },
      { money: { amount: '25', currency: 'BRL' } },
      { origin: 'INTERNAL' },
      { kind: 'OPENING' },
      { referenceExternalTransactionId: null },
    ]) {
      expect((await submit(transaction(wallet, 'BET', '25.00', extra))).response.status).toBe(400);
    }
    const missing = await post('/wagering/transactions', transaction(wallet));
    expect(missing.response.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(
      (
        await post('/wallets', {
          playerId: randomUUID(),
          initialBalance: { amount: '1.00', currency: 'USD' },
        })
      ).body.error.code,
    ).toBe('UNSUPPORTED_WALLET_CURRENCY');
    await reconciled(wallet.id, '100.00');
  });
  test('malformed JSON and an oversized body use safe 400/413 envelopes with correlation', async () => {
    for (const [body, expected] of [
      ['{"playerId":', 400],
      [JSON.stringify({ excess: 'x'.repeat(40000) }), 413],
    ] as const) {
      const response = await request('/wallets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.response.status).toBe(expected);
      expect(response.body.error.correlationId).toBe(
        response.response.headers.get('x-correlation-id'),
      );
      expect(JSON.stringify(response.body)).not.toContain('excess');
    }
  });
  test('identity boundary receives calls and invalid correlation values are replaced with a UUID', async () => {
    const wallet = await open();
    const input = transaction(wallet);
    const result = await submit(
      input,
      randomUUID(),
      'arbitrary-user-value' as ReturnType<typeof randomUUID>,
    );
    expect(result.response.status).toBe(200);
    expect(result.body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      identityCalls.some((call) => call.providerId === 'provider-a' && call.walletId === wallet.id),
    ).toBe(true);
    await reconciled(wallet.id, '75.00');
  });
  test('real SQL lock timeout returns 503 without accepting a financial transaction', async () => {
    const wallet = await open();
    let release!: () => void;
    let locked!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = db.owner.em.fork().transactional(async (em) => {
      await em.execute('select 1 from financial.wallets where id=? for update', [wallet.id]);
      locked();
      await barrier;
    });
    await ready;
    try {
      const result = await submit(transaction(wallet));
      expect(result.response.status).toBe(503);
      expect(result.body.error.code).toBe('INFRASTRUCTURE_UNAVAILABLE');
    } finally {
      release();
      await blocker;
    }
    await reconciled(wallet.id, '100.00');
  });
  test('stored result corruption returns a safe 500 and increments an integrity counter', async () => {
    const wallet = await open();
    const result = await submit(transaction(wallet));
    const before = diagnostics.counters();
    await db.owner.em.fork().transactional(async (em) => {
      await em.execute('alter table financial.wager_transactions disable trigger user');
      await em.execute('update financial.wager_transactions set result=?::jsonb where id=?', [
        JSON.stringify({ secret: 'database-sensitive-fixture' }),
        result.body.transactionId,
      ]);
      await em.execute('alter table financial.wager_transactions enable trigger user');
    });
    const response = await request(`/wagering/transactions/${result.body.transactionId}`);
    expect(response.response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toMatch(
      /database-sensitive-fixture|SELECT|INSERT|stack|password|postgresql/,
    );
    expect(diagnostics.counters().integrityFailures).toBe(before.integrityFailures + 1);
    await reconciled(wallet.id, '75.00');
  });
  test.each(['PROCESSED', 'REJECTED', 'PENDING_REFERENCE'] as const)(
    'PROC-020: %s balance currency corruption blocks queries and replay without rewriting history',
    async (status) => {
      const wallet = await open();
      const input =
        status === 'PENDING_REFERENCE'
          ? transaction(wallet, 'REFUND', '25.00', { referenceExternalTransactionId: 'missing' })
          : transaction(wallet, 'BET', status === 'REJECTED' ? '150.00' : '25.00');
      const key = randomUUID();
      const original = await submit(input, key);
      expect(original.body.status).toBe(status);
      // Only this test's UUID transaction is corrupted, in the disposable database.
      await db.owner.em.fork().transactional(async (em) => {
        await em.execute('alter table financial.wager_transactions disable trigger user');
        await em.execute(
          `update financial.wager_transactions set result=jsonb_set(result, '{balance,currency}', '"USD"'::jsonb) where id=?`,
          [original.body.transactionId],
        );
        await em.execute('alter table financial.wager_transactions enable trigger user');
      });
      const snapshot = () =>
        db.observer.em.fork().execute(
          `select result::text, status,
          (select count(*)::integer from financial.wallet_ledger_entries where wallet_id=?) as ledger,
          (select count(*)::integer from financial.outbox_messages where aggregate_id=?) as events
          from financial.wager_transactions where id=?`,
          [wallet.id, wallet.id, original.body.transactionId],
        );
      const before = await snapshot();
      for (const path of [
        `/wagering/transactions/${original.body.transactionId}`,
        `/providers/provider-a/wagering/transactions/${input.externalTransactionId}`,
      ]) {
        const result = await request(path);
        expect(result.response.status).toBe(500);
        expect(result.body.error.code).toBe('INTERNAL_ERROR');
        expect(JSON.stringify(result.body)).not.toMatch(/USD|SELECT|stack|postgresql/);
      }
      const replay = await submit(input, key);
      expect(replay.response.status).toBe(500);
      expect(replay.body.error.code).toBe('INTERNAL_ERROR');
      expect(await snapshot()).toEqual(before);
      await reconciled(wallet.id, status === 'PROCESSED' ? '75.00' : '100.00');
    },
  );
  test('FAILED can be queried with 200 without inventing recovery or reopening it', async () => {
    const wallet = await open('0.00');
    const loss = await submit(transaction(wallet, 'LOSS', '0.00'));
    await db.owner.em.fork().transactional(async (em) => {
      await em.execute('alter table financial.wager_transactions disable trigger user');
      await em.execute(
        "update financial.wager_transactions set status='FAILED', processed_at=null, failure_code='PERMANENT_PROCESSING_FAILURE', result=?::jsonb where id=?",
        [
          JSON.stringify({
            transactionId: loss.body.transactionId,
            status: 'FAILED',
            failureCode: 'PERMANENT_PROCESSING_FAILURE',
            balance: { amount: '0.00', currency: 'BRL' },
            httpStatus: 500,
          }),
          loss.body.transactionId,
        ],
      );
      await em.execute('alter table financial.wager_transactions enable trigger user');
    });
    const response = await request(`/wagering/transactions/${loss.body.transactionId}`);
    expect(response.response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'FAILED',
      failureCode: 'PERMANENT_PROCESSING_FAILURE',
    });
    await reconciled(wallet.id, '0.00');
  });

  test('QRY-015: a different API instance continues a cursor using the same stable key', async () => {
    const wallet = await open();
    await submit(transaction(wallet, 'WIN', '1.00'));
    const first = await request(`/wallets/${wallet.id}/ledger?limit=1`);
    const second = await createHttpApplication({
      databaseUrl: db.url,
      cursorSecret: 'http-fixture-signing-key-32-bytes-or-more',
      providers: ['provider-a'],
      diagnostics,
    });
    try {
      await second.listen(0, '127.0.0.1');
      const response = await fetch(
        `${await second.getUrl()}/wallets/${wallet.id}/ledger?limit=1&cursor=${first.body.nextCursor}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: { walletVersion: number }[];
        nextCursor?: string;
      };
      expect(body.items.map((entry) => entry.walletVersion)).toEqual([1]);
      expect(body.nextCursor).toBeUndefined();
    } finally {
      await second.close();
    }
    await reconciled(wallet.id, '101.00');
  });
  test('concurrent HTTP duplicates share the durable result and create only one movement', async () => {
    const wallet = await open();
    const input = transaction(wallet);
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 10 }, () => submit(input, key)));
    expect(responses.every((entry) => entry.response.status === 200)).toBe(true);
    expect(new Set(responses.map((entry) => entry.body.transactionId)).size).toBe(1);
    expect(responses.filter((entry) => entry.body.idempotentReplay === false)).toHaveLength(1);
    expect((await request(`/wallets/${wallet.id}/ledger`)).body.items).toHaveLength(2);
    await reconciled(wallet.id, '75.00');
  });
  test('a real read lock timeout becomes 503 rather than an internal or missing-resource error', async () => {
    const wallet = await open();
    let release!: () => void;
    let locked!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = db.owner.em.fork().transactional(async (em) => {
      await em.execute('lock table financial.wallets in access exclusive mode');
      locked();
      await barrier;
    });
    await ready;
    try {
      const response = await request(`/wallets/${wallet.id}`);
      expect(response.response.status).toBe(503);
      expect(response.body.error.code).toBe('INFRASTRUCTURE_UNAVAILABLE');
    } finally {
      release();
      await blocker;
    }
    await reconciled(wallet.id, '100.00');
  });
  test('the injected identity boundary can deny access without reaching a financial use case', async () => {
    const denied = await createHttpApplication({
      databaseUrl: db.url,
      cursorSecret: 'http-fixture-signing-key-32-bytes-or-more',
      providers: ['provider-a'],
      diagnostics,
      identity: {
        authorize: async () => {
          throw new ForbiddenException('Identity implementation denied access');
        },
      },
    });
    try {
      await denied.listen(0, '127.0.0.1');
      const response = await fetch(`${await denied.getUrl()}/wallets/${randomUUID()}`);
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('FORBIDDEN');
    } finally {
      await denied.close();
    }
  });
});
