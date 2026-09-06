import express from 'express';
import * as db from '../db.js';
import { isHouseholdMember } from '../services/member-email.js';
import {
  getNotificationPreferences, setNotificationPreferences, listNotificationInbox,
  markNotificationRead, markAllNotificationsRead, getInboxNotification,
} from '../services/notification-inbox.js';

export function buildInboxRouter({ database } = {}) {
  const router = express.Router();
  const getDb = () => database || db.get();
  router.use((req, res, next) => {
    // This is personal session state. Provider administration keeps its own
    // existing administrator guard in the router mounted after this one.
    if (!req.path.startsWith('/inbox') && req.path !== '/preferences') return next('router');
    const userId = Number(req.session?.userId);
    if (!userId || req.authMethod === 'api_token') return res.status(401).json({ error: 'Sign in to view your notifications.', code: 401 });
    if (!isHouseholdMember(userId, { db: getDb() })) return res.status(403).json({ error: 'Household membership required.', code: 403 });
    req.inboxUserId = userId;
    res.set('Cache-Control', 'private, no-store');
    return next();
  });
  const respond = (req, res) => res.json({ data: listNotificationInbox(getDb(), req.inboxUserId, { limit: req.query.limit }) });
  router.get('/inbox', respond);
  router.get('/inbox/:id', (req, res) => {
    const id = Number(req.params.id);
    const item = Number.isSafeInteger(id) && id > 0 ? getInboxNotification(getDb(), req.inboxUserId, id) : null;
    if (!item) return res.status(404).json({ error: 'Notification not found.', code: 404 });
    return res.json({ data: item });
  });
  router.post('/inbox/read-all', (req, res) => {
    markAllNotificationsRead(getDb(), req.inboxUserId);
    respond(req, res);
  });
  const mark = (dismiss) => (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0 || !markNotificationRead(getDb(), req.inboxUserId, id, { dismiss })) {
      return res.status(404).json({ error: 'Notification not found.', code: 404 });
    }
    return respond(req, res);
  };
  router.patch('/inbox/:id/read', mark(false));
  router.delete('/inbox/:id', mark(true));
  router.get('/preferences', (req, res) => res.json({ data: getNotificationPreferences(getDb(), req.inboxUserId) }));
  router.patch('/preferences', (req, res) => {
    try {
      res.json({ data: setNotificationPreferences(getDb(), req.inboxUserId, req.body) });
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ error: error.message, code: 400 });
      throw error;
    }
  });
  return router;
}

export default buildInboxRouter();
