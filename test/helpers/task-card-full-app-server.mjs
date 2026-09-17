// Dedicated process: real routes, authentication, schedulers, static assets and
// SSE against the browser suite's disposable synthetic database.
import net from 'node:net';
if (process.env.TASK_CARD_BROWSER_SERVER_CHILD === '1') {
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
