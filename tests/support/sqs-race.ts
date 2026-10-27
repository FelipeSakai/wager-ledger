interface Message {
  type: string;
  pid?: number;
  receiptHandle?: string;
  transferId?: string;
  transportMessageId?: string;
  name?: string;
}
export function sqsRace(url: string, input: string, dlq: string, mode = 'normal') {
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
  const child = Bun.spawn([process.execPath, Bun.resolveSync('./sqs-race-worker.ts', __dirname)], {
    env: {
      ...process.env,
      WAGER_TEST_DATABASE_URL: url,
      SQS_TEST_INPUT: input,
      SQS_TEST_DLQ: dlq,
      SQS_TEST_MODE: mode,
    },
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: 20000,
    ipc(value: unknown) {
      if (typeof value !== 'object' || !value || !('type' in value)) return;
      const message = value as Message;
      if (message.type === 'ERROR') {
        fail(new Error(`SQS worker failed: ${message.name}`));
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
      if (code !== 0 && code !== null) fail(new Error(`SQS worker exited: ${code}`));
    },
  });
  return {
    child,
    wait(type: string): Promise<Message> {
      if (failure) return Promise.reject(failure);
      const known = messages.get(type);
      if (known) return Promise.resolve(known);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(type);
          reject(new Error(`SQS worker timed out: ${type}`));
        }, 10000);
        listeners.set(type, { resolve, reject, timer });
      });
    },
  };
}
