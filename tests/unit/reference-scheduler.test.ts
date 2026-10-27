import { expect, test } from 'bun:test';
import type { ReferenceCursor } from '../../src/modules/financial/application/ports/pending-reference-store';
import { SchedulePendingReferences } from '../../src/modules/financial/application/use-cases/schedule-pending-references';
import { systemFinancialRuntime as runtime } from '../../src/modules/financial/infrastructure/runtime/system-financial-runtime';

const rows = Array.from({ length: 8 }, (_, index) => ({
  id: String(index),
  nextAttemptAt: '2026-10-27T18:00:00.000000Z',
}));
test('reference scheduler bounds parallel operations and isolates per-candidate failures', async () => {
  let active = 0;
  let peak = 0;
  const visited: string[] = [];
  const scheduler = new SchedulePendingReferences(
    { due: async () => rows, failures: async () => [] },
    {
      execute: async (id) => {
        active++;
        peak = Math.max(peak, active);
        visited.push(id);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        if (id === '1') throw new Error('Unclassified');
        return null;
      },
    },
    runtime,
    50,
    3,
  );
  expect(await scheduler.execute()).toEqual({ selected: 8, completed: 7, incomplete: 1 });
  expect(peak).toBe(3);
  expect(new Set(visited).size).toBe(8);
});
test('scan cursor advances past a failed full batch and cycles at the end', async () => {
  const cursors: (ReferenceCursor | undefined)[] = [];
  const scheduler = new SchedulePendingReferences(
    {
      due: async (_at, _limit, after) => {
        cursors.push(after);
        return after ? [] : rows.slice(0, 2);
      },
      failures: async () => [],
    },
    {
      execute: async () => {
        throw new Error('Unreadable');
      },
    },
    runtime,
    2,
    1,
  );
  await scheduler.execute();
  await scheduler.execute();
  await scheduler.execute();
  expect(cursors).toEqual([undefined, rows[1], undefined]);
});
test('stop drains admitted work and leaves unstarted candidates in the database', async () => {
  let release!: () => void;
  let ready!: () => void;
  const admitted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const visited: string[] = [];
  const scheduler = new SchedulePendingReferences(
    { due: async () => rows, failures: async () => [] },
    {
      execute: async (id) => {
        visited.push(id);
        ready();
        await gate;
        return null;
      },
    },
    runtime,
    50,
    1,
  );
  const pending = scheduler.execute();
  await admitted;
  expect(await scheduler.execute()).toEqual({ selected: 0, completed: 0, incomplete: 0 });
  scheduler.stop();
  release();
  expect(await pending).toEqual({ selected: 8, completed: 1, incomplete: 0 });
  expect(visited).toEqual(['0']);
  expect(await scheduler.execute()).toEqual({ selected: 0, completed: 0, incomplete: 0 });
});
test.each([0, 51, 1.5, NaN])('invalid scheduler batch %s is refused', (batch) => {
  expect(
    () =>
      new SchedulePendingReferences(
        { due: async () => [], failures: async () => [] },
        { execute: async () => null },
        runtime,
        batch,
      ),
  ).toThrow(RangeError);
});
