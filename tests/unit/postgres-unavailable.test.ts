import { expect, test } from 'bun:test';
import { isPostgresUnavailable } from '../../src/platform/database/postgres-unavailable';

test('driver disconnection errors remain operational when rollback loses the socket code', () => {
  expect(
    isPostgresUnavailable(
      new Error('Client has encountered a connection error and is not queryable'),
    ),
  ).toBe(true);
  expect(isPostgresUnavailable(new Error('Connection terminated unexpectedly'))).toBe(true);
  expect(
    isPostgresUnavailable(Object.assign(new Error('socket failure'), { code: 'ECONNRESET' })),
  ).toBe(true);
  expect(
    isPostgresUnavailable(Object.assign(new Error('connection failure'), { code: '08006' })),
  ).toBe(true);
});

test('unknown, business and SQL integrity errors are not classified by fuzzy message matching', () => {
  for (const error of [
    null,
    'Connection terminated unexpectedly',
    { message: 'Connection terminated unexpectedly' },
    new Error('Connection terminated'),
    new Error('unrelated connection error'),
    Object.assign(new Error('integrity failure'), { code: '23514' }),
    Object.assign(new Error('Connection terminated unexpectedly'), { code: '23514' }),
    Object.assign(new Error('bad code'), { code: '08' }),
  ])
    expect(isPostgresUnavailable(error)).toBe(false);
});
