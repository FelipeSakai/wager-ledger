import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { openWalletExample, transactionExamples } from './openapi-requests';
import { jsonResponse, schemaRef, uuidSchema } from './openapi-schemas';

export function ApiFinancialHttp() {
  return applyDecorators(
    ApiHeader({
      name: 'X-Correlation-Id',
      required: false,
      schema: uuidSchema,
      description:
        'UUID opcional. Se omitido ou inválido, a API gera outro e retorna no header de resposta.',
    }),
    ApiResponse(
      jsonResponse(400, 'Entrada, key, moeda, limite ou cursor inválido.', 'ErrorResponse'),
    ),
    ApiResponse(
      jsonResponse(
        500,
        'Falha interna ou integridade persistida inválida; resposta sanitizada.',
        'ErrorResponse',
      ),
    ),
    ApiResponse(
      jsonResponse(
        503,
        'Indisponibilidade transitória; consulte ou repita a mesma identidade, sem presumir rollback.',
        'ErrorResponse',
      ),
    ),
  );
}

export function ApiOpenWallet() {
  return applyDecorators(
    ApiTags('Wallets'),
    ApiOperation({
      operationId: 'openWallet',
      summary: 'Abrir wallet',
      description:
        'Cria wallet única por player/moeda. Abertura positiva gera crédito interno OPENING. Copie o id retornado para walletId das próximas chamadas. Use um playerId novo para outra demonstração.',
    }),
    ApiBody({
      schema: schemaRef('OpenWalletInput'),
      examples: { opening: { summary: 'Abrir com 100.00 BRL', value: openWalletExample } },
    }),
    ApiResponse(jsonResponse(201, 'Wallet criada, com saldo e versão inicial 1.', 'OpenedWallet')),
    ApiResponse(
      jsonResponse(
        409,
        'WALLET_ALREADY_EXISTS; error.details.walletId permite recuperar a wallet existente.',
        'ErrorResponse',
      ),
    ),
    ApiResponse(jsonResponse(413, 'Corpo JSON excede 32 KiB.', 'ErrorResponse')),
  );
}

export function ApiGetWallet() {
  return applyDecorators(
    ApiTags('Wallets'),
    ApiOperation({ operationId: 'getWallet', summary: 'Consultar saldo atual da wallet' }),
    ApiParam({
      name: 'walletId',
      schema: uuidSchema,
      description: 'Cole o id retornado pela abertura.',
    }),
    ApiResponse(
      jsonResponse(200, 'Saldo e versão atuais, com valores em strings exatas.', 'Wallet'),
    ),
    ApiResponse(jsonResponse(404, 'Wallet inexistente.', 'ErrorResponse')),
  );
}

export function ApiGetWalletLedger() {
  return applyDecorators(
    ApiTags('Wallets'),
    ApiOperation({
      operationId: 'getWalletLedger',
      summary: 'Paginar o ledger',
      description:
        'Ordem decrescente por walletVersion. A primeira página fixa o recorte; copie nextCursor para continuar. Movimentos posteriores aparecem numa paginação nova.',
    }),
    ApiParam({ name: 'walletId', schema: uuidSchema }),
    ApiQuery({
      name: 'limit',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    }),
    ApiQuery({
      name: 'cursor',
      required: false,
      schema: { type: 'string', maxLength: 2048 },
      description: 'Cursor opaco retornado em nextCursor; não edite nem reutilize em outra wallet.',
    }),
    ApiResponse(
      jsonResponse(200, 'Página de movimentos; nextCursor ausente ao terminar.', 'LedgerPage'),
    ),
    ApiResponse(jsonResponse(404, 'Wallet inexistente.', 'ErrorResponse')),
  );
}

export function ApiReconcileWallet() {
  return applyDecorators(
    ApiTags('Wallets'),
    ApiOperation({
      operationId: 'reconcileWallet',
      summary: 'Conferir saldo contra o ledger',
      description:
        'Consulta consistente e somente leitura. Não repara divergências. Envie body vazio ou {}.',
    }),
    ApiParam({ name: 'walletId', schema: uuidSchema }),
    ApiBody({
      required: false,
      schema: { type: 'object', additionalProperties: false, properties: {} },
      examples: { empty: { value: {} } },
    }),
    ApiResponse(
      jsonResponse(
        200,
        'Relatório exato; issues só aparece quando há divergências.',
        'Reconciliation',
      ),
    ),
    ApiResponse(jsonResponse(404, 'Wallet inexistente.', 'ErrorResponse')),
  );
}

export function ApiSubmitTransaction() {
  return applyDecorators(
    ApiTags('Transações'),
    ApiOperation({
      operationId: 'submitTransaction',
      summary: 'Submeter transação ou consultar replay',
      description:
        'Selecione um exemplo, cole walletId e mantenha o playerId da abertura. Ao trocar BET por WIN/LOSS/reversão, altere também Idempotency-Key conforme o exemplo escolhido. Repita corpo e key para replay. BET/WIN/reversões exigem valor positivo; LOSS exige zero. OPENING é interna. REFUND/ROLLBACK usam o ID externo da referência, do mesmo provider/player/wallet/moeda/round; reversões exigem valor integral.',
    }),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      schema: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        example: 'provider-a:swagger-bet-001',
      },
      description:
        'Obrigatória e globalmente única. Nova operação: nova key e novo externalTransactionId. Replay: mesma key e corpo. Mesma key com outro conteúdo retorna 409.',
    }),
    ApiBody({ schema: schemaRef('TransactionInput'), examples: transactionExamples }),
    ApiResponse(
      jsonResponse(
        200,
        'PROCESSED; replay preserva o saldo histórico mesmo após novos movimentos.',
        'ProcessedResult',
      ),
    ),
    ApiResponse(
      jsonResponse(
        202,
        'PENDING_REFERENCE; aguarde o worker e consulte por transactionId. Reenvio não força processamento.',
        'PendingReferenceResult',
      ),
    ),
    ApiResponse(jsonResponse(404, 'Wallet inexistente.', 'ErrorResponse')),
    ApiResponse(
      jsonResponse(
        409,
        'Conflito de key ou identidade externa; sem novo efeito financeiro.',
        'ErrorResponse',
      ),
    ),
    ApiResponse(jsonResponse(413, 'Corpo JSON excede 32 KiB.', 'ErrorResponse')),
    ApiResponse(
      jsonResponse(
        422,
        'REJECTED: regra de negócio, como saldo insuficiente, amount inadequado ou referência incompatível. Sem movimento de saldo.',
        'RejectedResult',
      ),
    ),
    ApiResponse({
      ...jsonResponse(
        500,
        'FAILED durável ou erro interno sanitizado, conforme o corpo da resposta.',
        'FailedResult',
      ),
      schema: { oneOf: [schemaRef('FailedResult'), schemaRef('ErrorResponse')] },
    }),
  );
}

export function ApiGetTransaction() {
  return applyDecorators(
    ApiTags('Transações'),
    ApiOperation({
      operationId: 'getTransaction',
      summary: 'Consultar transação por ID interno',
      description:
        'Recurso existente usa 200 em qualquer estado, incluindo rejeição, pendência e FAILED. Também consulta OPENING interna.',
    }),
    ApiParam({ name: 'transactionId', schema: uuidSchema }),
    ApiResponse(
      jsonResponse(
        200,
        'Transação e saldo observado no resultado; não é o saldo atual da wallet.',
        'Transaction',
      ),
    ),
    ApiResponse(jsonResponse(404, 'Transação inexistente.', 'ErrorResponse')),
  );
}

export function ApiGetExternalTransaction() {
  return applyDecorators(
    ApiTags('Transações'),
    ApiOperation({
      operationId: 'getExternalTransaction',
      summary: 'Consultar transação por identidade externa',
    }),
    ApiParam({
      name: 'providerId',
      schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', example: 'provider-a' },
    }),
    ApiParam({
      name: 'externalTransactionId',
      schema: { type: 'string', minLength: 1, maxLength: 128, example: 'swagger-bet-001' },
    }),
    ApiResponse(
      jsonResponse(
        200,
        'Mesmo recurso da consulta interna, inclusive saldo histórico.',
        'Transaction',
      ),
    ),
    ApiResponse(jsonResponse(404, 'Identidade externa inexistente.', 'ErrorResponse')),
  );
}
