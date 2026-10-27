import type { SubmissionResult } from '../../src/modules/financial/application/transactions/submission-result';
interface Message {
  type: string;
  pid: number;
  results: SubmissionResult[];
  name?: string;
  code?: string;
}

export function useCaseRace(url: string) {
  const messages = new Map<string, Message>();
  const listeners = new Map<
    string,
    {
      resolve: (message: Message) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let failure: Error | undefined;
  function fail(error: Error) {
    failure = error;
    for (const listener of listeners.values()) {
      clearTimeout(listener.timer);
      listener.reject(error);
    }
    listeners.clear();
  }
  const child = Bun.spawn(
    [process.execPath, Bun.resolveSync('./use-case-race-worker.ts', __dirname)],
    {
      env: { ...process.env, WAGER_TEST_DATABASE_URL: url },
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 15000,
      ipc(value: unknown) {
        if (typeof value !== 'object' || !value || !('type' in value)) return;
        const message = value as Message;
        if (message.type === 'ERROR')
          return fail(new Error(`Use-case worker failed: ${message.name} ${message.code ?? ''}`));
        messages.set(message.type, message);
        const listener = listeners.get(message.type);
        if (listener) {
          clearTimeout(listener.timer);
          listeners.delete(message.type);
          listener.resolve(message);
        }
      },
      onExit(_child, code) {
        if (code !== 0) fail(new Error(`Use-case worker exited: ${code}`));
      },
    },
  );
  return {
    child,
    wait(type: string): Promise<Message> {
      if (failure) return Promise.reject(failure);
      const value = messages.get(type);
      if (value) return Promise.resolve(value);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(type);
          reject(new Error(`Use-case worker timed out: ${type}`));
        }, 10000);
        listeners.set(type, { resolve, reject, timer });
      });
    },
  };
}
