import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { DependencyProbes, OperationalMetrics } from './operational-contracts';

type Check = { status: 'up' | 'down'; cause?: 'timeout' | 'unavailable' };
export class OperationalService {
  private initialized = false;
  private draining = false;
  private timer?: ReturnType<typeof setInterval>;
  private readiness?: Promise<{ status: string; dependencies: Record<string, Check> }>;
  private sampling?: Promise<void>;
  constructor(
    readonly telemetry: OperationalMetrics,
    private readonly probes: DependencyProbes,
    private readonly timeoutMilliseconds = 2000,
    private readonly intervalMilliseconds = 15000,
  ) {
    if (
      ![timeoutMilliseconds, intervalMilliseconds].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new RangeError('Invalid observability timing');
  }
  start(): void {
    if (this.initialized || this.draining) return;
    this.initialized = true;
    this.timer = setInterval(() => {
      void this.sample();
    }, this.intervalMilliseconds);
    this.timer.unref();
    void this.sample();
    this.telemetry.observe({ event: 'service_started' });
  }
  stop(): void {
    if (this.draining) return;
    this.draining = true;
    clearInterval(this.timer);
    this.telemetry.observe({ event: 'service_stopping', outcome: 'stopping' });
  }
  isDraining(): boolean {
    return this.draining;
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([this.sampling, this.readiness]);
  }
  private async probe<T>(
    dependency: 'postgres' | 'sqs',
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ check: Check; value?: T }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = performance.now();
    try {
      const value = await Promise.race([
        action(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Probe deadline exceeded'));
          }, this.timeoutMilliseconds);
        }),
      ]);
      return { check: { status: 'up' }, value };
    } catch {
      const cause = controller.signal.aborted ? 'timeout' : 'unavailable';
      this.telemetry.observe({
        event: 'dependency_probe',
        dependency,
        outcome: 'failure',
        cause,
        durationSeconds: (performance.now() - start) / 1000,
      });
      return { check: { status: 'down', cause } };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async ready(): Promise<{ status: string; dependencies: Record<string, Check> }> {
    if (!this.initialized || this.draining) return { status: 'not_ready', dependencies: {} };
    if (this.readiness) return this.readiness;
    this.readiness = (async () => {
      const [postgres, sqs] = await Promise.all([
        this.probe('postgres', (signal) => this.probes.postgres(signal)),
        this.probes.sqs ? this.probe('sqs', this.probes.sqs) : undefined,
      ]);
      const dependencies = { postgres: postgres.check, ...(sqs ? { sqs: sqs.check } : {}) };
      return {
        status:
          !this.draining && Object.values(dependencies).every((check) => check.status === 'up')
            ? 'ready'
            : 'not_ready',
        dependencies,
      };
    })();
    try {
      return await this.readiness;
    } finally {
      this.readiness = undefined;
    }
  }
  async sample(): Promise<void> {
    if (this.draining) return;
    if (this.sampling) return this.sampling;
    this.sampling = (async () => {
      await Promise.all([
        this.probe('postgres', (signal) => this.probes.backlog(signal)).then((result) =>
          this.telemetry.snapshot('postgres', result.value),
        ),
        this.probes.sqs
          ? this.probe('sqs', this.probes.sqs).then((result) =>
              this.telemetry.snapshot('sqs', result.value),
            )
          : undefined,
      ]);
    })();
    try {
      await this.sampling;
    } finally {
      this.sampling = undefined;
    }
  }
}
export async function startOperationalServer(
  service: OperationalService,
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new RangeError('Invalid operations port');
  const server = createServer((request, response) => {
    const path = request.url?.split('?')[0];
    if (request.method === 'GET' && path === '/metrics') {
      response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      response.end(service.telemetry.render());
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && path === '/health/live') {
      response.end(JSON.stringify({ status: 'alive' }));
      return;
    }
    if (request.method === 'GET' && path === '/health/ready') {
      void service.ready().then((result) => {
        response.statusCode = result.status === 'ready' ? 200 : 503;
        response.end(JSON.stringify(result));
      });
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ status: 'not_found' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
export function closeOperationalServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}
