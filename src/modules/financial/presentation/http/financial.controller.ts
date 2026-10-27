import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FinancialError } from '../../application/financial-error';
import { FinancialQueries } from '../../application/queries/financial-queries';
import { OpenWallet } from '../../application/use-cases/open-wallet';
import { ProcessTransaction } from '../../application/use-cases/process-transaction';
import { isRecord } from '../../domain/validation/domain-validation';
import type { FinancialHttpRequest, FinancialHttpResponse } from './http-contract';
import { ProviderIdentityGuard } from './provider-identity.guard';
import { submissionHttpStatus } from './submission-http-status';

@Controller()
@UseGuards(ProviderIdentityGuard)
export class FinancialController {
  constructor(
    @Inject(OpenWallet) private readonly open: OpenWallet,
    @Inject(ProcessTransaction) private readonly process: ProcessTransaction,
    @Inject(FinancialQueries) private readonly queries: FinancialQueries,
  ) {}

  @Post('wallets')
  openWallet(@Body() body: unknown, @Req() request: FinancialHttpRequest, @Query() query: unknown) {
    this.noQuery(query);
    return this.open.execute(body, request.correlationId);
  }
  @Get('wallets/:walletId')
  wallet(@Param('walletId') id: string, @Query() query: unknown) {
    this.noQuery(query);
    return this.queries.wallet(id);
  }
  @Get('wallets/:walletId/ledger')
  ledger(@Param('walletId') id: string, @Query() query: unknown) {
    return this.queries.ledger(id, query);
  }
  @Post('wallets/:walletId/reconciliation')
  async reconciliation(
    @Param('walletId') id: string,
    @Query() query: unknown,
    @Body() body: unknown,
    @Req() request: FinancialHttpRequest,
    @Res() response: FinancialHttpResponse,
  ) {
    this.noQuery(query);
    if (body !== undefined && (!isRecord(body) || Object.keys(body).length > 0))
      throw new FinancialError('INVALID_QUERY_INPUT');
    response.status(200).json(await this.queries.reconcile(id, request.correlationId!));
  }
  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Req() request: FinancialHttpRequest,
    @Res() response: FinancialHttpResponse,
    @Query() query: unknown,
  ) {
    this.noQuery(query);
    const result = await this.process.execute(
      body,
      request.headers['idempotency-key'],
      request.correlationId,
    );
    response.status(submissionHttpStatus(result.status)).json(result);
  }
  @Get('wagering/transactions/:transactionId')
  transaction(@Param('transactionId') id: string, @Query() query: unknown) {
    this.noQuery(query);
    return this.queries.transaction(id);
  }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  externalTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
    @Query() query: unknown,
  ) {
    this.noQuery(query);
    return this.queries.externalTransaction(providerId, externalId);
  }
  private noQuery(query: unknown): void {
    if (!isRecord(query) || Object.keys(query).length > 0)
      throw new FinancialError('INVALID_QUERY_INPUT');
  }
}
