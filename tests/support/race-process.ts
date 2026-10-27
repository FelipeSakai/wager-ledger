interface WorkerMessage {
  type: string;
  pid?: number;
  status?: string;
  name?: string;
  code?: string;
}

export function launchRaceWorker(url: string, walletId: string, amount: string, mode = 'normal') {
  const received = new Map<string, WorkerMessage>();
  const waiting = new Map<
    string,
    {
      resolve: (message: WorkerMessage) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = (error: Error): void => {
    for (const waiter of waiting.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiting.clear();
  };
  const child = Bun.spawn(
    [
      process.execPath,
      Bun.resolveSync('./wallet-race-worker.ts', __dirname),
      walletId,
      amount,
      mode,
    ],
    {
      env: { ...process.env, WAGER_TEST_DATABASE_URL: url },
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 15000,
      ipc(value: unknown) {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('type' in value) ||
          typeof value.type !== 'string'
        )
          return;
        const message = value as WorkerMessage;
        received.set(message.type, message);
        if (message.type === 'ERROR') {
          fail(new Error(`Race worker failed: ${message.name} ${message.code ?? ''}`));
          return;
        }
        const waiter = waiting.get(message.type);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiting.delete(message.type);
          waiter.resolve(message);
        }
      },
      onExit(_child, exitCode) {
        if (exitCode !== 0) fail(new Error(`Race worker exited with code ${exitCode}`));
      },
    },
  );
  return {
    child,
    waitFor(type: string): Promise<WorkerMessage> {
      const message = received.get(type);
      if (message) return Promise.resolve(message);
      const failed = received.get('ERROR');
      if (failed)
        return Promise.reject(new Error(`Race worker failed: ${failed.name} ${failed.code ?? ''}`));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(type);
          reject(new Error(`Race worker timed out awaiting ${type}`));
        }, 5000);
        waiting.set(type, { resolve, reject, timer });
      });
    },
  };
}
