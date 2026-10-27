import type { ApiResponseOptions, ReferenceObject, SchemaObject } from '@nestjs/swagger';

export const uuidSchema: SchemaObject = { type: 'string', format: 'uuid' };
const timestamp: SchemaObject = { type: 'string', format: 'date-time' };
const state: SchemaObject = {
  type: 'string',
  enum: ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'],
};
export const schemaRef = (name: string): ReferenceObject => ({
  $ref: `#/components/schemas/${name}`,
});

export function jsonResponse(
  status: number,
  description: string,
  model: string,
): ApiResponseOptions {
  return {
    status,
    description,
    schema: schemaRef(model),
    headers: {
      'X-Correlation-Id': { description: 'Correlação desta chamada HTTP.', schema: uuidSchema },
    },
  };
}

const moneyProperties = {
  amount: {
    type: 'string',
    pattern: '^(0|[1-9][0-9]{0,17})\\.[0-9]{2}$',
    maxLength: 21,
    example: '25.00',
    description:
      'Decimal exato, de 0.00 a 999999999999999999.99, sempre como string com duas casas.',
  } satisfies SchemaObject,
  currency: { type: 'string', enum: ['BRL'], example: 'BRL' } satisfies SchemaObject,
};

function submissionSchema(status: string, amount: string, failureCode?: string): SchemaObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'transactionId',
      'status',
      'balance',
      'idempotentReplay',
      'correlationId',
      ...(failureCode ? ['failureCode'] : []),
    ],
    properties: {
      transactionId: uuidSchema,
      status: { type: 'string', enum: [status] },
      balance: schemaRef('Money'),
      idempotentReplay: { type: 'boolean' },
      correlationId: uuidSchema,
      ...(failureCode ? { failureCode: { type: 'string' } as SchemaObject } : {}),
    },
    example: {
      transactionId: '00000000-0000-4000-8000-000000000103',
      status,
      balance: { amount, currency: 'BRL' },
      idempotentReplay: false,
      correlationId: '00000000-0000-4000-8000-000000000104',
      ...(failureCode ? { failureCode } : {}),
    },
  };
}

export const responseSchemas: Record<string, SchemaObject> = {
  Money: {
    type: 'object',
    additionalProperties: false,
    required: ['amount', 'currency'],
    properties: moneyProperties,
  },
  DiagnosticMoney: {
    type: 'object',
    required: ['amount', 'currency'],
    properties: {
      amount: {
        type: 'string',
        pattern: '^-?(0|[1-9][0-9]*)\\.[0-9]{2}$',
        example: '0.00',
        description: 'Total diagnóstico exato; pode ser negativo ou ultrapassar a faixa de Money.',
      },
      currency: moneyProperties.currency,
    },
  },
  OpenedWallet: {
    type: 'object',
    required: ['id', 'playerId', 'balance', 'version'],
    properties: {
      id: uuidSchema,
      playerId: uuidSchema,
      balance: schemaRef('Money'),
      version: { type: 'integer', minimum: 1, example: 1 },
    },
  },
  Wallet: {
    type: 'object',
    required: ['id', 'playerId', 'balance', 'version', 'createdAt', 'updatedAt'],
    properties: {
      id: uuidSchema,
      playerId: uuidSchema,
      balance: schemaRef('Money'),
      version: { type: 'integer', minimum: 1, example: 1 },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  },
  LedgerEntry: {
    type: 'object',
    required: [
      'id',
      'walletId',
      'transactionId',
      'walletVersion',
      'direction',
      'money',
      'balanceBefore',
      'balanceAfter',
      'createdAt',
    ],
    properties: {
      id: uuidSchema,
      walletId: uuidSchema,
      transactionId: uuidSchema,
      walletVersion: { type: 'integer', minimum: 1 },
      direction: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
      money: schemaRef('Money'),
      balanceBefore: schemaRef('Money'),
      balanceAfter: schemaRef('Money'),
      createdAt: timestamp,
    },
  },
  LedgerPage: {
    type: 'object',
    required: ['items'],
    properties: {
      items: { type: 'array', items: schemaRef('LedgerEntry') },
      nextCursor: {
        type: 'string',
        description: 'Ausente na última página. Copie o valor inteiro para a próxima chamada.',
      },
    },
  },
  ProcessedResult: submissionSchema('PROCESSED', '75.00'),
  PendingReferenceResult: submissionSchema('PENDING_REFERENCE', '85.00'),
  RejectedResult: submissionSchema('REJECTED', '85.00', 'INSUFFICIENT_FUNDS'),
  FailedResult: submissionSchema('FAILED', '85.00', 'INVALID_REFERENCE_STATE'),
  Transaction: {
    type: 'object',
    required: [
      'id',
      'walletId',
      'playerId',
      'origin',
      'kind',
      'status',
      'money',
      'result',
      'createdAt',
    ],
    properties: {
      id: uuidSchema,
      walletId: uuidSchema,
      playerId: uuidSchema,
      origin: { type: 'string', enum: ['INTERNAL', 'PROVIDER'] },
      kind: { type: 'string', enum: ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] },
      status: state,
      money: schemaRef('Money'),
      providerId: { type: 'string' },
      externalTransactionId: { type: 'string' },
      roundId: { type: 'string' },
      gameId: { type: 'string' },
      referenceExternalTransactionId: { type: 'string' },
      referenceTransactionId: uuidSchema,
      failureCode: { type: 'string' },
      result: {
        type: 'object',
        required: ['status', 'balance'],
        properties: { status: state, balance: schemaRef('Money'), failureCode: { type: 'string' } },
      },
      createdAt: timestamp,
      processedAt: timestamp,
      completedAt: timestamp,
    },
  },
  Reconciliation: {
    type: 'object',
    required: [
      'walletId',
      'storedBalance',
      'calculatedBalance',
      'difference',
      'consistent',
      'checkedEntries',
    ],
    properties: {
      walletId: uuidSchema,
      storedBalance: schemaRef('Money'),
      calculatedBalance: schemaRef('DiagnosticMoney'),
      difference: schemaRef('DiagnosticMoney'),
      consistent: { type: 'boolean' },
      checkedEntries: { type: 'integer', minimum: 0 },
      issues: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ausente quando não há divergências.',
      },
    },
  },
  ErrorResponse: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'correlationId'],
        properties: {
          code: {
            type: 'string',
            description: 'Código estável da causa, por exemplo IDEMPOTENCY_CONFLICT.',
          },
          message: { type: 'string' },
          correlationId: uuidSchema,
          details: {
            type: 'object',
            description: 'WALLET_ALREADY_EXISTS inclui o walletId existente para recuperação.',
            properties: { walletId: uuidSchema },
          },
        },
      },
    },
  },
};
