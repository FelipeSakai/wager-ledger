import { createConnection, createServer, type Socket } from 'node:net';

// Test-only plaintext PostgreSQL proxy. Observe the server's real COMMIT completion,
// then reset the client before forwarding that response. No ORM/SQL result is mocked.
export async function postgresCommitResponseProxy(databaseUrl: string) {
  const destination = new URL(databaseUrl);
  const sockets = new Set<Socket>();
  let armed = false;
  let droppedResponses = 0;
  const server = createServer((client) => {
    const backend = createConnection({
      host: destination.hostname,
      port: Number(destination.port || '5432'),
    });
    for (const socket of [client, backend]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    }
    client.on('error', () => backend.destroy());
    backend.on('error', () => client.destroy());
    client.on('close', () => backend.destroy());
    backend.on('close', () => client.destroy());
    client.pipe(backend);
    let pending = Buffer.alloc(0);
    backend.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1) + 1;
        if (length < 5 || length > 1024 * 1024) {
          client.destroy(new Error('Invalid PostgreSQL test proxy frame'));
          return;
        }
        if (pending.length < length) return;
        const frame = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (armed && frame[0] === 0x43 && frame.subarray(5).equals(Buffer.from('COMMIT\0'))) {
          armed = false;
          droppedResponses++;
          client.resetAndDestroy();
          backend.destroy();
          return;
        }
        client.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy port');
  const url = new URL(databaseUrl);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  url.searchParams.set('sslmode', 'disable');
  return {
    url: url.href,
    arm() {
      armed = true;
    },
    get droppedResponses() {
      return droppedResponses;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
