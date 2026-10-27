import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type SchemaObject } from '@nestjs/swagger';
import { requestSchemas } from '../modules/financial/presentation/http/openapi-requests';
import { responseSchemas } from '../modules/financial/presentation/http/openapi-schemas';

export function setupHttpOpenApi(app: NestExpressApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Wager Ledger API')
    .setVersion('0.1.0')
    .setOpenAPIVersion('3.0.3')
    .setDescription(
      'API local para testar wallets e transações. 1) Abra uma wallet e copie o id retornado. ' +
        '2) Em Submeter transação, escolha BET, cole walletId e mantenha o playerId da abertura. ' +
        '3) Preencha Idempotency-Key; cada operação nova precisa de uma key e um externalTransactionId novos. ' +
        'Para replay, repita exatamente corpo e key. Valores financeiros são strings com duas casas. ' +
        'Os exemplos usam provider-a, admitido na configuração local padrão. ' +
        'Autenticação externa está adiada; as chamadas executam operações reais no banco local.',
    )
    .addServer('/', 'Mesma origem da API')
    .addTag('Wallets', 'Abertura, saldo, ledger e reconciliação')
    .addTag('Transações', 'Submissão, replay e consulta')
    .addTag('Operação', 'Identificação, health e métricas deste processo')
    .build();
  const document = SwaggerModule.createDocument(app, config, { autoTagControllers: false });
  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, ...responseSchemas, ...requestSchemas },
  };
  const readiness: SchemaObject = {
    type: 'object',
    required: ['status', 'dependencies'],
    properties: {
      status: { type: 'string', enum: ['ready', 'not_ready'] },
      dependencies: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['up', 'down'] },
            cause: { type: 'string', enum: ['timeout', 'unavailable'] },
          },
        },
      },
    },
  };
  document.paths['/health/live'] = {
    get: {
      operationId: 'liveness',
      tags: ['Operação'],
      summary: 'Verificar processo vivo',
      responses: {
        '200': {
          description: 'Processo vivo; independe de PostgreSQL/SQS.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: { status: { type: 'string', enum: ['alive'] } },
              },
            },
          },
        },
      },
    },
  };
  document.paths['/health/ready'] = {
    get: {
      operationId: 'readiness',
      tags: ['Operação'],
      summary: 'Verificar dependências e prontidão',
      responses: Object.fromEntries(
        [200, 503].map((status) => [
          String(status),
          {
            description:
              status === 200
                ? 'Pronto para receber operações.'
                : 'Dependência indisponível ou processo em drenagem.',
            content: { 'application/json': { schema: readiness } },
          },
        ]),
      ),
    },
  };
  document.paths['/metrics'] = {
    get: {
      operationId: 'metrics',
      tags: ['Operação'],
      summary: 'Consultar métricas Prometheus',
      responses: {
        '200': {
          description: 'Métricas deste processo; gauges SQL não devem ser somados entre papéis.',
          content: { 'text/plain': { schema: { type: 'string' } } },
        },
      },
    },
  };
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    raw: ['json'],
    customSiteTitle: 'Wager Ledger — API',
    swaggerOptions: {
      validatorUrl: null,
      docExpansion: 'list',
      filter: true,
      displayRequestDuration: true,
      defaultModelsExpandDepth: -1,
    },
  });
}
