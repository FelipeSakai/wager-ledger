import { expect, test } from 'bun:test';
import { closeResources, ProcessShutdown } from '../../src/platform/process/shutdown';

test('cleanup attempts later resources after an earlier close fails', async () => {
  const order: number[] = [];
  await expect(
    closeResources([
      async () => {
        order.push(1);
        throw new Error('Unavailable resource');
      },
      () => {
        order.push(2);
      },
    ]),
  ).rejects.toBeInstanceOf(AggregateError);
  expect(order).toEqual([1, 2]);
});
test('repeated shutdown requests retain one deadline until cleanup completes', async () => {
  let stops = 0;
  let exited!: (code: number) => void;
  const result = new Promise<number>((resolve) => {
    exited = resolve;
  });
  const shutdown = new ProcessShutdown(
    30,
    () => {
      stops++;
    },
    exited,
  );
  try {
    shutdown.request();
    shutdown.request();
    expect(await result).toBe(1);
    expect(stops).toBe(1);
  } finally {
    shutdown.complete();
  }
});
test('successful cleanup cancels the deadline and removes signal handlers', async () => {
  const before = process.listenerCount('SIGTERM');
  let exits = 0;
  const shutdown = new ProcessShutdown(
    20,
    () => {},
    () => {
      exits++;
    },
  );
  shutdown.request();
  shutdown.complete();
  await Bun.sleep(40);
  expect(exits).toBe(0);
  expect(process.listenerCount('SIGTERM')).toBe(before);
});
