import {
  ApiFinancialHttp,
  ApiOpenWallet,
  ApiGetWallet,
  ApiGetWalletLedger,
  ApiReconcileWallet,
  ApiSubmitTransaction,
  ApiGetTransaction,
  ApiGetExternalTransaction,
} from './openapi-operations';
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
@ApiFinancialHttp()
export class FinancialController {
  constructor(
    @Inject(OpenWallet) private readonly open: OpenWallet,
    @Inject(ProcessTransaction) private readonly process: ProcessTransaction,
    @Inject(FinancialQueries) private readonly queries: FinancialQueries,
  ) {}

  @Post('wallets')
  @ApiOpenWallet()
  openWallet(@Body() body: unknown, @Req() request: FinancialHttpRequest, @Query() query: unknown) {
    this.noQuery(query);
    return this.open.execute(body, request.correlationId);
  }
  @Get('wallets/:walletId')
  @ApiGetWallet()
  wallet(@Param('walletId') id: string, @Query() query: unknown) {
    this.noQuery(query);
    return this.queries.wallet(id);
  }
  @Get('wallets/:walletId/ledger')
  @ApiGetWalletLedger()
  ledger(@Param('walletId') id: string, @Query() query: unknown) {
    return this.queries.ledger(id, query);
  }
  @Post('wallets/:walletId/reconciliation')
  @ApiReconcileWallet()
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
  @ApiSubmitTransaction()
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
  @ApiGetTransaction()
  transaction(@Param('transactionId') id: string, @Query() query: unknown) {
    this.noQuery(query);
    return this.queries.transaction(id);
  }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiGetExternalTransaction()
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
