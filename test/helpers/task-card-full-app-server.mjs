// Dedicated process: real routes, authentication, schedulers, static assets and
// SSE against the browser suite's disposable synthetic database.
import net from 'node:net';
import express from 'express';
import { fileURLToPath } from 'node:url';
if (process.env.TASK_CARD_BROWSER_SERVER_CHILD === '1') {
  // Windows test checkouts live under .codex. Express sendFile rejects hidden
  // ancestors by default; production's /app path does not have this fixture issue.
  if (process.platform === 'win32') {
    const index = fileURLToPath(new URL('../../public/index.html', import.meta.url));
    const sendFile = express.response.sendFile;
    express.response.sendFile = function (file, options, callback) {
      if (file === index) return sendFile.call(this, file, { ...options, dotfiles: 'allow' }, callback);
      return sendFile.call(this, file, options, callback);
    };
  }
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    if (args[0] === '0') {
      args[0] = 0; args.splice(1, 0, '127.0.0.1');
      this.once('listening', () => process.send?.({ origin: `http://127.0.0.1:${this.address().port}` }));
    }
    return listen.apply(this, args);
  };
  await import('../../server/index.js');
}
