import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import { FinancialError, FinancialStorageError } from '../../application/financial-error';
import type { QueryDiagnostics } from '../../application/ports/financial-read-store';
import type { FinancialRuntime } from '../../application/ports/financial-runtime';
import { MoneyError } from '../../domain/money/money-error';
import type { FinancialHttpRequest, FinancialHttpResponse } from './http-contract';

@Catch()
export class FinancialExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly runtime: FinancialRuntime,
    private readonly diagnostics: QueryDiagnostics,
  ) {}
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FinancialHttpRequest>();
    const response = http.getResponse<FinancialHttpResponse>();
    const correlationId = request.correlationId ?? this.runtime.newId();
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'An internal error prevented this operation';
    let details: Readonly<{ walletId: string }> | undefined;
    if (exception instanceof FinancialError) {
      if (
        [
          'INVALID_TRANSACTION_INPUT',
          'INVALID_IDEMPOTENCY_KEY',
          'UNKNOWN_PROVIDER',
          'UNSUPPORTED_TRANSACTION_CURRENCY',
          'UNSUPPORTED_WALLET_CURRENCY',
          'INVALID_WALLET_INPUT',
          'INVALID_QUERY_INPUT',
          'INVALID_CURSOR',
        ].includes(exception.code)
      )
        status = 400;
      else if (['WALLET_NOT_FOUND', 'TRANSACTION_NOT_FOUND'].includes(exception.code)) status = 404;
      else if (
        ['WALLET_ALREADY_EXISTS', 'IDEMPOTENCY_CONFLICT', 'EXTERNAL_TRANSACTION_CONFLICT'].includes(
          exception.code,
        )
      )
        status = 409;
      else if (exception.code === 'INFRASTRUCTURE_UNAVAILABLE') status = 503;
      if (status !== 500) {
        code = exception.code;
        message = exception.message;
      }
      if (exception.code === 'WALLET_ALREADY_EXISTS') details = exception.details;
    } else if (
      exception instanceof MoneyError &&
      ['INVALID_MONEY_AMOUNT', 'INVALID_CURRENCY', 'MONEY_OUT_OF_RANGE'].includes(exception.code)
    ) {
      status = 400;
      code = exception.code;
      message = exception.message;
    } else if (
      exception instanceof FinancialStorageError &&
      ['TRANSIENT', 'UNAVAILABLE'].includes(exception.code)
    ) {
      status = 503;
      code = 'INFRASTRUCTURE_UNAVAILABLE';
      message = 'Financial storage is temporarily unavailable';
    } else if (
      typeof exception === 'object' &&
      exception !== null &&
      'type' in exception &&
      exception.type === 'entity.too.large' &&
      'status' in exception &&
      exception.status === 413
    ) {
      status = 413;
      code = 'INVALID_REQUEST';
      message = 'HTTP request is too large';
    } else if (exception instanceof HttpException) {
      const value = exception.getStatus();
      if ([400, 404, 405, 413, 415, 401, 403].includes(value)) {
        status = value;
        code =
          value === 404
            ? 'RESOURCE_NOT_FOUND'
            : value === 403
              ? 'FORBIDDEN'
              : value === 401
                ? 'UNAUTHORIZED'
                : 'INVALID_REQUEST';
        message =
          value === 404
            ? 'Resource was not found'
            : value === 403 || value === 401
              ? 'Access is not permitted'
              : 'HTTP request is invalid';
      }
    }
    if (status === 500) this.diagnostics.integrityFailure(correlationId);
    response.setHeader('X-Correlation-Id', correlationId);
    response
      .status(status)
      .json({ error: { code, message, correlationId, ...(details ? { details } : {}) } });
  }
}
