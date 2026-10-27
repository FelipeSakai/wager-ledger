import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createHttpApplication } from '../../src/bootstrap/http-application';
import { financialTestDatabase } from '../support/financial-test-database';

let db: Awaited<ReturnType<typeof financialTestDatabase>>;
let app: Awaited<ReturnType<typeof createHttpApplication>>;
let base: string;
let document: Record<string, any>;
beforeAll(async () => {
  db = await financialTestDatabase();
  app = await createHttpApplication({
    databaseUrl: db.url,
    cursorSecret: 'openapi-fixture-signing-key-at-least-32-bytes',
    providers: ['provider-a', 'provider-b'],
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  const response = await fetch(`${base}/docs-json`);
  expect(response.status).toBe(200);
  document = (await response.json()) as Record<string, any>;
}, 30000);
afterAll(async () => {
  if (app) await app.close();
  if (db) await db.close();
}, 30000);

test('OpenAPI documents every public API operation with portable server URLs and resolvable references', () => {
  const expected = [
    'get /',
    'get /health/live',
    'get /health/ready',
    'get /metrics',
    'post /wallets',
    'get /wallets/{walletId}',
    'get /wallets/{walletId}/ledger',
    'post /wallets/{walletId}/reconciliation',
    'post /wagering/transactions',
    'get /wagering/transactions/{transactionId}',
    'get /providers/{providerId}/wagering/transactions/{externalTransactionId}',
  ];
  const actual = Object.entries(document.paths).flatMap(([path, value]) =>
    Object.keys(value as object).map((method) => `${method} ${path}`),
  );
  expect(actual.sort()).toEqual(expected.sort());
  expect(document.openapi).toBe('3.0.3');
  expect(document.servers).toEqual([{ url: '/', description: 'Mesma origem da API' }]);
  expect(document.components.securitySchemes ?? {}).toEqual({});
  const ids = Object.values(document.paths).flatMap((path: any) =>
    Object.values(path).map((operation: any) => operation.operationId),
  );
  expect(new Set(ids).size).toBe(expected.length);
  const tags = document.tags.map((tag: any) => tag.name);
  for (const path of Object.values(document.paths) as any[]) {
    for (const operation of Object.values(path) as any[]) {
      expect(operation.tags).toHaveLength(1);
      expect(tags).toContain(operation.tags[0]);
    }
  }
  const references = JSON.stringify(document).matchAll(/"\$ref":"([^"]+)"/g);
  for (const [, ref] of references) {
    expect(ref!.startsWith('#/')).toBe(true);
    const resolved = ref!
      .slice(2)
      .split('/')
      .reduce((value: any, key) => value?.[key], document);
    expect(resolved).toBeDefined();
  }
});

test('Swagger serves its UI and assets locally without an external validator or financial side effects', async () => {
  const count = async () =>
    db.observer.em.fork().execute('select count(*)::text as count from financial.wallets');
  const before = await count();
  const html = await fetch(`${base}/docs`).then((response) => response.text());
  expect(html).toContain('swagger-ui');
  expect(html).toContain('Wager Ledger');
  expect(html).not.toMatch(/https?:\/\/[^"\s]+\.(?:js|css)/);
  for (const asset of ['swagger-ui-bundle.js', 'swagger-ui.css', 'swagger-ui-init.js']) {
    const response = await fetch(`${base}/docs/${asset}`);
    expect(response.status).toBe(200);
    if (asset.endsWith('init.js')) {
      const script = await response.text();
      expect(script).toMatch(/"validatorUrl"\s*:\s*null/);
    }
  }
  expect(await count()).toEqual(before);
});

test('documented requests preserve money strings, reference rules, headers and query bounds', () => {
  const schemas = document.components.schemas;
  expect(schemas.Money.properties.amount.type).toBe('string');
  expect(schemas.Money.properties.currency.enum).toEqual(['BRL']);
  const amount = new RegExp(schemas.Money.properties.amount.pattern);
  expect(amount.test('25.00')).toBe(true);
  expect(amount.test('25.0')).toBe(false);
  expect(amount.test('1000000000000000000.00')).toBe(false);
  expect(schemas.OpenWalletInput.additionalProperties).toBe(false);
  expect(schemas.BetInput.properties).not.toHaveProperty('referenceExternalTransactionId');
  expect(schemas.ReversalInput.required).toContain('referenceExternalTransactionId');
  expect(schemas.OutcomeInput.required).not.toContain('referenceExternalTransactionId');
  const operation = document.paths['/wagering/transactions'].post;
  expect(operation.parameters.find((p: any) => p.name === 'Idempotency-Key')).toMatchObject({
    in: 'header',
    required: true,
  });
  expect(operation.requestBody.required).toBe(true);
  for (const [status, state] of [
    ['200', 'PROCESSED'],
    ['202', 'PENDING_REFERENCE'],
    ['422', 'REJECTED'],
  ]) {
    const ref = operation.responses[status!].content['application/json'].schema.$ref;
    const model = schemas[ref.split('/').at(-1)];
    expect(model.properties.status.enum).toEqual([state]);
    expect(model.example.status).toBe(state);
    expect('failureCode' in model.properties).toBe(status === '422');
  }
  expect(Object.keys(operation.responses).sort()).toEqual([
    '200',
    '202',
    '400',
    '404',
    '409',
    '413',
    '422',
    '500',
    '503',
  ]);
  const limit = document.paths['/wallets/{walletId}/ledger'].get.parameters.find(
    (p: any) => p.name === 'limit',
  );
  expect(limit.schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 100, default: 50 });
  expect(document.paths['/metrics'].get.responses['200'].content).toHaveProperty('text/plain');
});

test('Swagger request examples execute the real wallet, transaction, replay and query flow', async () => {
  const post = async (path: string, body: unknown, key?: string) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const opening = structuredClone(
    document.paths['/wallets'].post.requestBody.content['application/json'].examples.opening.value,
  );
  opening.playerId = randomUUID();
  const wallet = await post('/wallets', opening);
  expect(wallet.status).toBe(201);
  const openingRef =
    document.paths['/wallets'].post.responses['201'].content['application/json'].schema.$ref;
  for (const field of document.components.schemas[openingRef.split('/').at(-1)].required) {
    expect(wallet.body).toHaveProperty(field);
  }
  const examples =
    document.paths['/wagering/transactions'].post.requestBody.content['application/json'].examples;
  const command = structuredClone(examples.BET.value);
  command.walletId = wallet.body.id;
  command.playerId = opening.playerId;
  command.externalTransactionId = randomUUID();
  const key = randomUUID();
  const bet = await post('/wagering/transactions', command, key);
  expect(bet.status).toBe(200);
  expect(bet.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
  const win = {
    ...structuredClone(examples.WIN.value),
    walletId: wallet.body.id,
    playerId: opening.playerId,
    externalTransactionId: randomUUID(),
  };
  expect((await post('/wagering/transactions', win, randomUUID())).status).toBe(200);
  const replay = await post('/wagering/transactions', command, key);
  expect(replay.body).toMatchObject({
    transactionId: bet.body.transactionId,
    idempotentReplay: true,
    balance: { amount: '75.00', currency: 'BRL' },
  });
  const resource = (await fetch(`${base}/wagering/transactions/${bet.body.transactionId}`).then(
    (response) => response.json(),
  )) as any;
  const external = await fetch(
    `${base}/providers/${command.providerId}/wagering/transactions/${command.externalTransactionId}`,
  ).then((response) => response.json());
  expect(resource).toEqual(external);
  expect(resource.result.balance.amount).toBe('75.00');
  const current = (await fetch(`${base}/wallets/${wallet.body.id}`).then((response) =>
    response.json(),
  )) as any;
  expect(current.balance.amount).toBe('85.00');
  const walletRef =
    document.paths['/wallets/{walletId}'].get.responses['200'].content['application/json'].schema
      .$ref;
  for (const field of document.components.schemas[walletRef.split('/').at(-1)].required) {
    expect(current).toHaveProperty(field);
  }
  const ledger = (await fetch(`${base}/wallets/${wallet.body.id}/ledger?limit=2`).then((response) =>
    response.json(),
  )) as any;
  expect(ledger.items).toHaveLength(2);
  expect(ledger.nextCursor).toBeString();
  const reconciled = await post(`/wallets/${wallet.body.id}/reconciliation`, {});
  expect(reconciled.status).toBe(200);
  expect(reconciled.body).toMatchObject({
    consistent: true,
    storedBalance: { amount: '85.00', currency: 'BRL' },
    calculatedBalance: { amount: '85.00', currency: 'BRL' },
    difference: { amount: '0.00', currency: 'BRL' },
  });
  const loss = {
    ...structuredClone(examples.LOSS.value),
    walletId: wallet.body.id,
    playerId: opening.playerId,
    externalTransactionId: randomUUID(),
  };
  expect((await post('/wagering/transactions', loss, randomUUID())).body.balance.amount).toBe(
    '85.00',
  );
  const refund = {
    ...structuredClone(examples.REFUND.value),
    walletId: wallet.body.id,
    playerId: opening.playerId,
    externalTransactionId: randomUUID(),
    referenceExternalTransactionId: command.externalTransactionId,
  };
  expect((await post('/wagering/transactions', refund, randomUUID())).body.balance.amount).toBe(
    '110.00',
  );
  const rollback = {
    ...structuredClone(examples.ROLLBACK.value),
    walletId: wallet.body.id,
    playerId: opening.playerId,
    externalTransactionId: randomUUID(),
    referenceExternalTransactionId: win.externalTransactionId,
  };
  expect((await post('/wagering/transactions', rollback, randomUUID())).body.balance.amount).toBe(
    '100.00',
  );
  const final = await post(`/wallets/${wallet.body.id}/reconciliation`, {});
  expect(final.body).toMatchObject({
    consistent: true,
    checkedEntries: 5,
    storedBalance: { amount: '100.00', currency: 'BRL' },
    calculatedBalance: { amount: '100.00', currency: 'BRL' },
    difference: { amount: '0.00', currency: 'BRL' },
  });
});
