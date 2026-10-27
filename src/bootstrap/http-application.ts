import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Server, ServerResponse } from 'node:http';
import 'reflect-metadata';
import type { QueryDiagnostics } from '../modules/financial/application/ports/financial-read-store';
import { ProviderIdentityPort } from '../modules/financial/application/ports/provider-identity';
import { FinancialQueries } from '../modules/financial/application/queries/financial-queries';
import { OpenWallet } from '../modules/financial/application/use-cases/open-wallet';
import { ProcessTransaction } from '../modules/financial/application/use-cases/process-transaction';
import { isUuid } from '../modules/financial/domain/validation/domain-validation';
import {
  LocalDependencyProbes,
  type ObservedQueue,
} from '../modules/financial/infrastructure/observability/dependency-probes';
import { OperationalTelemetry } from '../modules/financial/infrastructure/observability/operational-telemetry';
import { FinancialQueryDiagnostics } from '../modules/financial/infrastructure/observability/query-diagnostics';
import { MikroFinancialUnitOfWork } from '../modules/financial/infrastructure/persistence/mikro-financial-unit-of-work';
import { HmacLedgerCursor } from '../modules/financial/infrastructure/queries/hmac-ledger-cursor';
import { MikroFinancialReadStore } from '../modules/financial/infrastructure/queries/mikro-financial-read-store';
import { systemFinancialRuntime } from '../modules/financial/infrastructure/runtime/system-financial-runtime';
import { FinancialExceptionFilter } from '../modules/financial/presentation/http/financial-exception-filter';
import { FinancialController } from '../modules/financial/presentation/http/financial.controller';
import type {
  FinancialHttpRequest,
  FinancialHttpResponse,
} from '../modules/financial/presentation/http/http-contract';
import { ProviderIdentityGuard } from '../modules/financial/presentation/http/provider-identity.guard';
import { sqsClient } from '../platform/messaging/sqs-client';
import type { DependencyProbes } from '../platform/observability/operational-contracts';
import { OperationalService } from '../platform/observability/operational-service';
import { AppController } from './app.controller';
import { createOrm } from './financial-database';
import { setupHttpOpenApi } from './http-openapi';

export interface HttpApplicationOptions {
  databaseUrl: string;
  cursorSecret: string;
  providers: readonly string[];
  diagnostics?: QueryDiagnostics;
  identity?: ProviderIdentityPort;
  telemetry?: OperationalTelemetry;
  probes?: DependencyProbes;
  sqsEndpoint?: string;
  queues?: readonly ObservedQueue[];
  probeTimeoutMilliseconds?: number;
  probeIntervalMilliseconds?: number;
}
// Deliberate local default while the external identity integration is deferred.
class DeferredLocalIdentity extends ProviderIdentityPort {
  async authorize(): Promise<void> {}
}
const operationsForApp = new WeakMap<NestExpressApplication, OperationalService>();
export function beginHttpShutdown(app: NestExpressApplication): void {
  operationsForApp.get(app)?.stop();
  const server: Server = app.getHttpServer();
  server.closeIdleConnections();
}
@Module({})
class FinancialHttpModule {}

export async function createHttpApplication(
  options: HttpApplicationOptions,
): Promise<NestExpressApplication> {
  for (const value of [
    options.probeTimeoutMilliseconds ?? 2000,
    options.probeIntervalMilliseconds ?? 15000,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError('Invalid observability timing');
  }
  const cursor = new HmacLedgerCursor(options.cursorSecret);
  const orm = await createOrm(options.databaseUrl);
  const telemetry = options.telemetry ?? new OperationalTelemetry('http');
  const client = sqsClient({
    endpoint: options.sqsEndpoint ?? process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    local: true,
  });
  const operations = new OperationalService(
    telemetry,
    options.probes ??
      new LocalDependencyProbes(
        orm,
        client,
        options.queues ?? [
          { name: process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo', dlq: false },
          { name: process.env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo', dlq: true },
          { name: process.env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo', dlq: false },
          { name: process.env.SQS_EVENTS_DLQ_NAME ?? 'wager-events-dlq.fifo', dlq: true },
        ],
      ),
    options.probeTimeoutMilliseconds,
    options.probeIntervalMilliseconds,
  );
  let app: NestExpressApplication | undefined;
  try {
    const unit = new MikroFinancialUnitOfWork(orm, telemetry);
    const localDiagnostics = new FinancialQueryDiagnostics(() => {}, telemetry);
    const diagnostics: QueryDiagnostics = {
      reconciliationIssue: (...args) => {
        localDiagnostics.reconciliationIssue(...args);
        try {
          options.diagnostics?.reconciliationIssue(...args);
        } catch {}
      },
      integrityFailure: (...args) => {
        localDiagnostics.integrityFailure(...args);
        try {
          options.diagnostics?.integrityFailure(...args);
        } catch {}
      },
    };
    const module: DynamicModule = {
      module: FinancialHttpModule,
      controllers: [AppController, FinancialController],
      providers: [
        {
          provide: OpenWallet,
          useValue: new OpenWallet(unit, systemFinancialRuntime, {}, telemetry),
        },
        {
          provide: ProcessTransaction,
          useValue: new ProcessTransaction(
            unit,
            systemFinancialRuntime,
            options.providers,
            {},
            telemetry,
          ),
        },
        {
          provide: FinancialQueries,
          useValue: new FinancialQueries(new MikroFinancialReadStore(orm), cursor, diagnostics),
        },
        {
          provide: ProviderIdentityPort,
          useValue: options.identity ?? new DeferredLocalIdentity(),
        },
        ProviderIdentityGuard,
        {
          provide: 'FinancialDatabaseLifecycle',
          useValue: {
            onApplicationBootstrap: () => operations.start(),
            beforeApplicationShutdown: () => beginHttpShutdown(app!),
            onApplicationShutdown: async () => {
              await operations.close();
              client.destroy();
              await orm.close(true);
            },
          },
        },
      ],
    };
    app = await NestFactory.create<NestExpressApplication>(module, {
      logger: false,
      bodyParser: false,
      abortOnError: false,
    });
    app.use((request: FinancialHttpRequest, response: FinancialHttpResponse, next: () => void) => {
      const incoming = request.headers['x-correlation-id'];
      request.correlationId =
        typeof incoming === 'string' && isUuid(incoming)
          ? incoming
          : systemFinancialRuntime.newId();
      response.setHeader('X-Correlation-Id', request.correlationId);
      const started = performance.now();
      const native = response as unknown as ServerResponse;
      const socket = native.socket;
      native.once('finish', () =>
        telemetry.observe({
          event: 'http_request',
          correlationId: request.correlationId,
          transport: 'http',
          outcome: native.statusCode >= 500 ? 'failure' : 'success',
          durationSeconds: (performance.now() - started) / 1000,
        }),
      );
      native.once('finish', () => {
        if (operations.isDraining()) socket?.end();
      });
      const path = (request as FinancialHttpRequest & { path?: string }).path;
      if (
        operations.isDraining() &&
        !['/health/live', '/health/ready', '/metrics'].includes(path ?? '')
      ) {
        response.status(503).json({
          error: {
            code: 'SERVICE_STOPPING',
            message: 'Service is stopping',
            correlationId: request.correlationId,
          },
        });
        return;
      }
      next();
    });
    const adapter = app.getHttpAdapter();
    adapter.get('/health/live', (_request: unknown, response: { json(value: unknown): void }) =>
      response.json({ status: 'alive' }),
    );
    adapter.get('/health/ready', (_request: unknown, response: FinancialHttpResponse) => {
      void operations
        .ready()
        .then((result) => response.status(result.status === 'ready' ? 200 : 503).json(result));
    });
    adapter.get(
      '/metrics',
      (
        _request: unknown,
        response: { setHeader(name: string, value: string): void; send(value: string): void },
      ) => {
        response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        response.send(telemetry.render());
      },
    );
    operationsForApp.set(app, operations);
    app.useBodyParser('json', { limit: '32kb', strict: false });
    app.useGlobalFilters(new FinancialExceptionFilter(systemFinancialRuntime, diagnostics));
    setupHttpOpenApi(app);
    await app.init();
    return app;
  } catch (error) {
    if (app) await app.close();
    await operations.close();
    client.destroy();
    await orm.close(true);
    throw error;
  }
}
