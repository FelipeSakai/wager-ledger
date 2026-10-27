export interface ProviderAccessContext {
  authorization?: string;
  providerId?: string;
  walletId?: string;
  transactionId?: string;
}
// Bootstrap selects the implementation; HTTP always invokes this boundary.
export abstract class ProviderIdentityPort {
  abstract authorize(context: ProviderAccessContext): Promise<void>;
}
