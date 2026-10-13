import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Reuse an existing local QA dependency tree without installing anything.
const require=createRequire(process.env.DEVICE_PRIZE_QA_MODULES
  ? resolve(process.env.DEVICE_PRIZE_QA_MODULES,'../package.json') : import.meta.url);
export default (await import(pathToFileURL(require.resolve('puppeteer')).href)).default;
