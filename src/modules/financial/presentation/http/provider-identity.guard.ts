import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ProviderIdentityPort } from '../../application/ports/provider-identity';
import { isRecord } from '../../domain/validation/domain-validation';
import type { FinancialHttpRequest } from './http-contract';

@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  constructor(@Inject(ProviderIdentityPort) private readonly identity: ProviderIdentityPort) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FinancialHttpRequest>();
    const providerId =
      request.params?.providerId ??
      (isRecord(request.body) && typeof request.body.providerId === 'string'
        ? request.body.providerId
        : undefined);
    const authorization = request.headers.authorization;
    await this.identity.authorize({
      authorization: typeof authorization === 'string' ? authorization : undefined,
      providerId,
      walletId:
        request.params?.walletId ??
        (isRecord(request.body) && typeof request.body.walletId === 'string'
          ? request.body.walletId
          : undefined),
      transactionId: request.params?.transactionId,
    });
    return true;
  }
}
