import type { ExampleObject, ReferenceObject, SchemaObject } from '@nestjs/swagger';
import { schemaRef, uuidSchema } from './openapi-schemas';

const identifier = (maximum: number): SchemaObject => ({
  type: 'string',
  minLength: 1,
  maxLength: maximum,
});
const properties = {
  providerId: { ...identifier(64), pattern: '^[A-Za-z0-9_-]+$', example: 'provider-a' },
  externalTransactionId: identifier(128),
  playerId: uuidSchema,
  walletId: uuidSchema,
  roundId: identifier(128),
  gameId: identifier(128),
  money: schemaRef('Money'),
};

function transactionInput(
  kinds: string[],
  reference: 'none' | 'optional' | 'required',
): SchemaObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      ...Object.keys(properties),
      'kind',
      ...(reference === 'required' ? ['referenceExternalTransactionId'] : []),
    ],
    properties: {
      ...properties,
      kind: { type: 'string', enum: kinds },
      ...(reference === 'none' ? {} : { referenceExternalTransactionId: identifier(128) }),
    },
  };
}

export const requestSchemas: Record<string, SchemaObject> = {
  OpenWalletInput: {
    type: 'object',
    additionalProperties: false,
    required: ['playerId', 'initialBalance'],
    properties: { playerId: uuidSchema, initialBalance: schemaRef('Money') },
  },
  BetInput: transactionInput(['BET'], 'none'),
  OutcomeInput: transactionInput(['WIN', 'LOSS'], 'optional'),
  ReversalInput: transactionInput(['REFUND', 'ROLLBACK'], 'required'),
  TransactionInput: {
    oneOf: [schemaRef('BetInput'), schemaRef('OutcomeInput'), schemaRef('ReversalInput')],
    discriminator: {
      propertyName: 'kind',
      mapping: {
        BET: '#/components/schemas/BetInput',
        WIN: '#/components/schemas/OutcomeInput',
        LOSS: '#/components/schemas/OutcomeInput',
        REFUND: '#/components/schemas/ReversalInput',
        ROLLBACK: '#/components/schemas/ReversalInput',
      },
    },
  },
};

export const openWalletExample = {
  playerId: '00000000-0000-4000-8000-000000000101',
  initialBalance: { amount: '100.00', currency: 'BRL' },
};

export const transactionExamples: Record<string, ExampleObject | ReferenceObject> =
  Object.fromEntries(
    [
      ['BET', '25.00', 'swagger-bet-001', undefined],
      ['WIN', '10.00', 'swagger-win-001', undefined],
      ['LOSS', '0.00', 'swagger-loss-001', undefined],
      ['REFUND', '25.00', 'swagger-refund-001', 'swagger-bet-001'],
      ['ROLLBACK', '10.00', 'swagger-rollback-001', 'swagger-win-001'],
    ].map(([kind, amount, externalTransactionId, reference]) => [
      kind,
      {
        summary: `${kind}: Idempotency-Key provider-a:${externalTransactionId}`,
        description:
          'Copie walletId da abertura e use o mesmo playerId. Ao iniciar outra demonstração, troque IDs externos, referências e keys.',
        value: {
          providerId: 'provider-a',
          externalTransactionId,
          playerId: openWalletExample.playerId,
          walletId: '00000000-0000-4000-8000-000000000102',
          roundId: 'swagger-round-001',
          gameId: 'swagger-game',
          kind,
          money: { amount, currency: 'BRL' },
          ...(reference ? { referenceExternalTransactionId: reference } : {}),
        },
      },
    ]),
  );
