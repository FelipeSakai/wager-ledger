// The deadline covers admitted work AND resource cleanup. It remains referenced
// so a hanging cleanup promise cannot turn a timeout into a false successful exit.
export class ProcessShutdown {
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  constructor(
    private readonly milliseconds: number,
    private readonly stop: () => void,
    private readonly exit: (code: number) => void = (code) => process.exit(code),
  ) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1)
      throw new RangeError('Invalid shutdown budget');
    process.on('SIGTERM', this.request);
    process.on('SIGINT', this.request);
  }
  readonly request = (): void => {
    if (this.stopping) return;
    this.stopping = true;
    this.timer = setTimeout(() => this.exit(1), this.milliseconds);
    this.stop();
  };
  complete(): void {
    clearTimeout(this.timer);
    process.off('SIGTERM', this.request);
    process.off('SIGINT', this.request);
  }
}

// Attempt every cleanup even if an earlier resource fails. The process deadline
// stays active while these operations run, including a resource that never settles.
export async function closeResources(
  resources: readonly (() => void | Promise<void>)[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const close of resources) {
    try {
      await close();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Resource cleanup failed');
}
