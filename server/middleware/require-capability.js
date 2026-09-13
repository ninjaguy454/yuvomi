import * as db from '../db.js';
import { assertCapability } from '../permissions.js';

export function requireCapability(key) {
  return (req, res, next) => {
    try { assertCapability(db.get(), req, key); return next(); }
    catch (error) { return res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not check household permissions.', code: error.status || 500 }); }
  };
}
