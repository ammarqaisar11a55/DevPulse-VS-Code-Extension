import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeServer } from '../../unit/fakeServer';

/** Serves the in-memory FakeServer over real HTTP for the Extension Development Host. */
export async function startHttpFakeServer(): Promise<{
  server: FakeServer;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const fake = new FakeServer();
  const httpServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (fake.offline) {
        req.socket.destroy();
        return;
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string')
          headers[key === 'authorization' ? 'Authorization' : key] = value;
      }
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
      void fake
        .fetch(`http://localhost${req.url ?? '/'}`, { method: req.method, headers, body })
        .then(async (response) => {
          const text = await response.text();
          const responseHeaders: Record<string, string> = { 'content-type': 'application/json' };
          response.headers.forEach((value, key) => (responseHeaders[key] = value));
          res.writeHead(response.status, responseHeaders);
          res.end(text);
        })
        .catch(() => req.socket.destroy());
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    server: fake,
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    close: () => new Promise((resolve) => httpServer.close(() => resolve())),
  };
}
