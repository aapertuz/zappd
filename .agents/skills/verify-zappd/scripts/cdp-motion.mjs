import { once } from 'node:events';
import { createServer } from 'node:http';

import { emulateReducedMotion, withCdpPage } from './cdp-browser.mjs';

const [, , pageWsUrl, motion] = process.argv;

await withCdpPage(pageWsUrl, async (cdp) => {
  const browserClosed = cdp.waitForClose();
  if (motion === 'true' || motion === 'false') await emulateReducedMotion(cdp, motion === 'true');

  const server = createServer((request, response) => {
    if (request.method !== 'PUT' || !['/motion/true', '/motion/false'].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    void emulateReducedMotion(cdp, request.url === '/motion/true').then(
      () => response.writeHead(204).end(),
      () => response.writeHead(502).end(),
    );
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.send({ port: server.address().port });
  await browserClosed;
  server.close();
  server.closeAllConnections();
});
