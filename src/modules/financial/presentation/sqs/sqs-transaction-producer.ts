import type { SqsTransport } from '../../application/ports/queue-transport';
import { transactionEnvelope } from './transaction-envelope';
export class SqsTransactionProducer {
  constructor(
    private readonly transport: SqsTransport,
    private readonly destination: string,
  ) {}
  async send(body: string): Promise<void> {
    const envelope = transactionEnvelope(body);
    await this.transport.send(this.destination, body, envelope.walletId, envelope.messageId);
  }
}
