interface Message {
  type: string;
  pid?: number;
  selected?: number;
  completed?: number;
  incomplete?: number;
  name?: string;
}
export function referenceRace(url: string, time: string, mode = 'normal') {
  const messages = new Map<string, Message>();
  let failure: Error | undefined;
  const listeners = new Map<
    string,
    {
      resolve: (message: Message) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = (error: Error) => {
    failure = error;
    for (const listener of listeners.values()) {
      clearTimeout(listener.timer);
      listener.reject(error);
    }
    listeners.clear();
  };
  const child = Bun.spawn(
    [process.execPath, Bun.resolveSync('./reference-race-worker.ts', __dirname)],
    {
      env: {
        ...process.env,
        WAGER_TEST_DATABASE_URL: url,
        REFERENCE_TEST_TIME: time,
        REFERENCE_TEST_MODE: mode,
      },
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 20000,
      ipc(value: unknown) {
        if (typeof value !== 'object' || value === null || !('type' in value)) return;
        const message = value as Message;
        if (message.type === 'ERROR') {
          fail(new Error(`Reference worker failed: ${message.name}`));
          return;
        }
        messages.set(message.type, message);
        const listener = listeners.get(message.type);
        if (listener) {
          clearTimeout(listener.timer);
          listeners.delete(message.type);
          listener.resolve(message);
        }
      },
      onExit(_child, code) {
        if (code !== 0 && code !== null) fail(new Error(`Reference worker exited: ${code}`));
      },
    },
  );
  return {
    child,
    wait(type: string): Promise<Message> {
      if (failure) return Promise.reject(failure);
      const known = messages.get(type);
      if (known) return Promise.resolve(known);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(type);
          reject(new Error(`Reference worker timed out: ${type}`));
        }, 10000);
        listeners.set(type, { resolve, reject, timer });
      });
    },
  };
}
