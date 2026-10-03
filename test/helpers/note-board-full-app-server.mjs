// Actual app; suppress SW installation so worker upgrades do not race the test
// runner's hot source checkout. All auth/API/static routes remain production code.
import http from 'node:http';
import express from 'express';
express.application.listen = function (_port, callback) {
  const app = this;
  const server = http.createServer((req, res) => {
    if (req.url?.split('?')[0] === '/sw.js') { res.writeHead(404); res.end(); return; }
    app(req, res);
  });
  return server.listen(0, '127.0.0.1', () => {
    callback?.();
    process.send?.({ origin: `http://127.0.0.1:${server.address().port}` });
  });
};
await import('../../server/index.js');
