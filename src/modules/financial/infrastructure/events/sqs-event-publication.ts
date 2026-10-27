import type { EventPublicationTransport } from '../../application/ports/financial-outbox-store';
import type { SqsTransport } from '../../application/ports/queue-transport';
export class SqsEventPublication implements EventPublicationTransport {
  constructor(
    private readonly transport: Pick<SqsTransport, 'send'>,
    private readonly destination: string,
  ) {}
  send(body: string, groupId: string, eventId: string): Promise<void> {
    return this.transport.send(this.destination, body, groupId, eventId);
  }
}
