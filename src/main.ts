import { ProcessShutdown } from './platform/process/shutdown';
import { beginHttpShutdown, createHttpApplication } from './bootstrap/http-application';
import { OperationalTelemetry } from './modules/financial/infrastructure/observability/operational-telemetry';

const telemetry = new OperationalTelemetry('http');
async function bootstrap(): Promise<void> {
  const configuredPort = process.env.PORT ?? '3000';
  const port = Number(configuredPort);
  if (!/^\d+$/.test(configuredPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const databaseUrl = process.env.DATABASE_URL;
  const cursorSecret = process.env.LEDGER_CURSOR_SECRET;
  if (!databaseUrl || !cursorSecret)
    throw new Error('DATABASE_URL and LEDGER_CURSOR_SECRET must be configured');
  const providers = (process.env.FINANCIAL_PROVIDERS ?? 'provider-a,provider-b').split(',');
  if (providers.length === 0 || providers.some((value) => !/^[A-Za-z0-9_-]{1,64}$/.test(value)))
    throw new Error('FINANCIAL_PROVIDERS is invalid');
  const app = await createHttpApplication({
    databaseUrl,
    cursorSecret,
    providers,
    telemetry,
    probeTimeoutMilliseconds: Number(process.env.PROBE_TIMEOUT_MILLISECONDS ?? '2000'),
    probeIntervalMilliseconds: Number(process.env.PROBE_INTERVAL_MILLISECONDS ?? '15000'),
  });
  const shutdown = Number(process.env.HTTP_SHUTDOWN_MILLISECONDS ?? '30000');
  if (!Number.isSafeInteger(shutdown) || shutdown < 1) {
    await app.close();
    throw new Error('Invalid HTTP shutdown budget');
  }
  const lifecycle = new ProcessShutdown(shutdown, () => {
    beginHttpShutdown(app);
    void app.close().then(
      () => lifecycle.complete(),
      () => {
        // A failed close may leave handles open; retain the referenced deadline.
        process.exitCode = 1;
      },
    );
  });
  try {
    await app.listen(port, process.env.HTTP_HOST ?? '127.0.0.1');
  } catch (error) {
    try {
      await app.close();
    } finally {
      lifecycle.complete();
    }
    throw error;
  }
}
bootstrap().catch(() => {
  telemetry.observe({
    event: 'worker_poll_failed',
    component: 'http',
    outcome: 'failure',
    cause: 'internal',
  });
  process.exitCode = 1;
});
