/**
 * Modul: Notification-Orchestrator
 * Zweck: Reminder an Web Push und externe Notification-Channels fan-outen und Delivery-State pflegen.
 * Abhaengigkeiten: server/db.js, push.js, notification-channels.js, Provider-Adapter
 */
import { createLogger } from '../logger.js';
import * as dbModule from '../db.js';
import { pushService as defaultPushService } from './push.js';
import { createNotificationChannelStore } from './notification-channels.js';
import { gotifyProvider } from './notification-providers/gotify.js';
import { ntfyProvider } from './notification-providers/ntfy.js';
import { webhookProvider } from './notification-providers/webhook.js';
import { emailProvider } from './notification-providers/email.js';
import { guardedFetch } from './notification-providers/guarded-fetch.js';
import { syncAllBirthdayReminders } from './birthdays.js';
import { resolveHouseholdLocale, translate } from '../utils/i18n.js';
import { warrantyEndDate } from './inventory-deadlines.js';
import { syncAllPantryExpiryReminders } from './pantry-reminders.js';
import { enqueueNotification, canReceiveNotification, getNotificationPreferences } from './notification-inbox.js';
import { isNotificationDeliveryCurrent } from './notification-events.js';

const log = createLogger('Notifications');
const APP_NAME = 'Yuvomi';
// Greift nur, wenn die verknuepfte Entitaet inzwischen geloescht wurde: nie den
// App-Namen als Body wiederholen, sonst besteht die Notification nur aus "Yuvomi" (#581).
const FALLBACK_BODY = 'Reminder';
const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
// Exportiert, damit die Zeitschranken des Mail-Transports (services/email.js)
// dagegen gepruefte werden koennen statt gegen eine abgeschriebene Zahl: die
// Staffelung ist die Zusicherung, nicht der einzelne Wert.
export const PROVIDER_TIMEOUT_MS = 8_000;

export const defaultProviders = {
  gotify: gotifyProvider,
  ntfy: ntfyProvider,
  webhook: webhookProvider,
  email: emailProvider,
};

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeError(error) {
  return String(error?.message || error || 'Notification delivery failed.').slice(0, 500);
}

/**
 * Body einer Abo-Erinnerung: Name, Betrag und Verlaengerungsdatum (#581).
 * Bewusst nur Daten, kein Satzbau - der Server kennt die Sprache des Empfaengers
 * nicht (Locale und Zahlen-/Datumsformat liegen im localStorage des Clients),
 * deshalb ISO-Datum und Betrag mit Waehrungscode statt formulierter Text.
 */
function subscriptionBody(reminder) {
  const parts = [reminder.entity_title];
  const amount = Number(reminder.sub_amount);
  if (Number.isFinite(amount) && reminder.sub_currency) {
    parts.push(`${amount.toFixed(2)} ${reminder.sub_currency}`);
  }
  if (reminder.sub_next_payment_date) parts.push(String(reminder.sub_next_payment_date).slice(0, 10));
  return parts.join(' - ');
}

/**
 * DER TITEL EINER MELDUNG NENNT IHRE HERKUNFT.
 *
 * Die Herkunfts-Regel (Block 2) gibt jeder Meldung ihr Siegel - eine
 * Systembenachrichtigung kann keines tragen: sie hat kein DOM, ihr `icon` zeigt
 * nur ein Teil der Plattformen, und ihr `badge` wird auf Android monochrom
 * maskiert, wodurch der Familienton ohnehin verloren ginge. Was auf JEDER
 * Plattform ankommt, ist der Titel, und der stand bisher app-weit auf „Yuvomi" -
 * also auf dem, was das System darueber ohnehin schon anzeigt. „Kalender" ueber
 * „Zahnarzttermin" beantwortet dieselbe Frage wie das Siegel im Toast.
 *
 * UEBERSETZT UEBER DIE DATENSPRACHE DES HAUSHALTS, nicht ueber die des
 * Empfaengers: die kennt der Server nicht (Locale liegt im localStorage). Das
 * ist dieselbe Sprache, in der er schon Geburtstagstermine ablegt, und dieselbe
 * Quelle - public/locales/*.json ueber utils/i18n.js. Die Keys sind bestehende
 * Modulnamen; eine Meldung braucht dafuer kein eigenes Vokabular.
 */
// Deep links are resolved once by notification-inbox.js for reminders and
// domain events alike; the saved inbox URL is then used by every transport.
const REMINDER_ORIGINS = {
  task:                   { titleKey: 'nav.tasks' },
  event:                  { titleKey: 'nav.calendar' },
  subscription:           { titleKey: 'subscriptions.tabLabel' },
  inventory_item:         { titleKey: 'nav.inventory' },
  inventory_tracked_date: { titleKey: 'nav.inventory' },
  pantry_item:            { titleKey: 'nav.pantry' },
  meal:                   { titleKey: 'nav.meals' },
};

/**
 * Body einer Garantie-Erinnerung: Gegenstandsname und Garantieende.
 * Gleiche Begruendung wie bei subscriptionBody - reine Daten, kein Satzbau,
 * weil der Server die Sprache des Empfaengers nicht kennt. Faellt das
 * Garantieende nicht berechenbar aus (unplausibles Kaufdatum, geloeschte
 * Felder), bleibt der Name allein stehen statt die Zustellung zu sprengen.
 */
function warrantyBody(reminder) {
  if (!reminder.inv_purchase_date || reminder.inv_warranty_months == null) return reminder.entity_title;
  try {
    return `${reminder.entity_title} - ${warrantyEndDate(reminder.inv_purchase_date, reminder.inv_warranty_months)}`;
  } catch {
    return reminder.entity_title;
  }
}

/**
 * Body einer Fristen-Erinnerung: Gegenstand · Bezeichnung, plus das Datum.
 * Gleiche Begruendung wie subscriptionBody/warrantyBody - reine Daten, kein
 * Satzbau, weil der Server die Sprache des Empfaengers nicht kennt.
 */
function trackedDateBody(reminder) {
  if (!reminder.inv_tracked_date) return reminder.entity_title;
  return `${reminder.entity_title} - ${reminder.inv_tracked_date}`;
}

/**
 * Body einer Ablauf-Erinnerung: Artikelname und Mindesthaltbarkeitsdatum.
 * Gleiche Begruendung wie die drei Funktionen darueber - reine Daten, kein
 * Satzbau, weil der Server die Sprache des Empfaengers nicht kennt.
 */
function pantryExpiryBody(reminder) {
  if (!reminder.pantry_expires_on) return reminder.entity_title;
  return `${reminder.entity_title} - ${reminder.pantry_expires_on}`;
}

function reminderPayload(reminder, locale) {
  const title = reminder.entity_title || FALLBACK_BODY;
  const origin = REMINDER_ORIGINS[reminder.entity_type];
  let body = title;
  if (reminder.entity_type === 'subscription' && reminder.entity_title) {
    body = subscriptionBody(reminder);
  } else if (reminder.entity_type === 'inventory_item' && reminder.entity_title) {
    body = warrantyBody(reminder);
  } else if (reminder.entity_type === 'inventory_tracked_date' && reminder.entity_title) {
    body = trackedDateBody(reminder);
  } else if (reminder.entity_type === 'pantry_item' && reminder.entity_title) {
    body = pantryExpiryBody(reminder);
  }
  return {
    // Ohne bekannte Herkunft bleibt der App-Name: er ist nichtssagend, aber nie
    // falsch - und ein roher `entity_type` im Titel waere beides.
    title: origin ? translate(locale, origin.titleKey) : APP_NAME,
    body,
  };
}

function upsertPendingDelivery(database, { notificationId, provider, channelId = null, targetKey, nowIso }) {
  database.prepare(`
    INSERT INTO notification_inbox_deliveries
      (notification_id, provider, channel_id, target_key, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(notification_id, provider, target_key) DO NOTHING
  `).run(notificationId, provider, channelId, targetKey, nowIso, nowIso);
  return database.prepare(`
    SELECT * FROM notification_inbox_deliveries
    WHERE notification_id = ? AND provider = ? AND target_key = ?
  `).get(notificationId, provider, targetKey);
}

function shouldAttempt(delivery, nowIso) {
  if (!delivery) return true;
  if (delivery.status === 'sent' || delivery.status === 'skipped') return false;
  if (delivery.status === 'failed' && delivery.next_attempt_at && delivery.next_attempt_at > nowIso) return false;
  return delivery.attempt_count < MAX_ATTEMPTS;
}

function markSent(database, deliveryId, nowIso) {
  database.prepare(`
    UPDATE notification_inbox_deliveries
    SET status = 'sent',
        attempt_count = attempt_count + 1,
        last_attempt_at = ?,
        next_attempt_at = NULL,
        sent_at = ?,
        error = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(nowIso, nowIso, nowIso, deliveryId);
}

function markSkipped(database, deliveryId, nowIso, reason) {
  database.prepare(`
    UPDATE notification_inbox_deliveries
    SET status = 'skipped',
        next_attempt_at = NULL,
        error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(reason, nowIso, deliveryId);
}

function markFailed(database, deliveryId, now, error) {
  const nowIso = iso(now);
  const row = database.prepare('SELECT attempt_count FROM notification_inbox_deliveries WHERE id = ?').get(deliveryId);
  const nextAttempt = (row?.attempt_count ?? 0) + 1;
  const exhausted = nextAttempt >= MAX_ATTEMPTS;
  database.prepare(`
    UPDATE notification_inbox_deliveries
    SET status = ?,
        attempt_count = ?,
        last_attempt_at = ?,
        next_attempt_at = ?,
        error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    exhausted ? 'skipped' : 'failed',
    nextAttempt,
    nowIso,
    exhausted ? null : iso(new Date(now.getTime() + RETRY_DELAY_MS)),
    safeError(error),
    nowIso,
    deliveryId
  );
  return exhausted ? 'skipped' : 'failed';
}

function allKnownDeliveriesComplete(database, notificationId, expectedTargets) {
  if (expectedTargets.length === 0) return true;
  const rows = database.prepare(`
    SELECT provider, target_key, status
    FROM notification_inbox_deliveries
    WHERE notification_id = ?
  `).all(notificationId);
  const byKey = new Map(rows.map((row) => [`${row.provider}:${row.target_key}`, row.status]));
  return expectedTargets.every((target) => {
    const status = byKey.get(`${target.provider}:${target.targetKey}`);
    return status === 'sent' || status === 'skipped';
  });
}

async function withTimeout(fn, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function createNotificationService({ providers = defaultProviders, channelStore } = {}) {
  async function testChannel({ channel, payload, fetchImpl = guardedFetch } = {}) {
    const provider = providers[channel?.provider];
    if (!provider) throw new Error('Unknown notification provider.');
    return withTimeout((signal) => provider.send({ channel, payload, fetchImpl, signal }));
  }

  return { providers, channelStore, testChannel };
}

// Every entry point shares the same run for one database. A slow provider must
// not let the next scheduler tick send the same pending target concurrently.
const activeRuns = new WeakMap();

export function processDueNotifications(options = {}) {
  const database = options.database || dbModule.get();
  if (activeRuns.has(database)) return activeRuns.get(database);
  const run = Promise.resolve().then(() => runDueNotifications({ ...options, database }))
    .finally(() => { if (activeRuns.get(database) === run) activeRuns.delete(database); });
  activeRuns.set(database, run);
  return run;
}

function importReminderDeliveries(database, notificationId, reminderId) {
  // Keep successful receipts and the remaining retry budget from before the
  // inbox upgrade. No broad data rewrite and no repeat of accepted deliveries.
  database.prepare(`
    INSERT INTO notification_inbox_deliveries
      (notification_id, provider, channel_id, target_key, status, attempt_count,
       next_attempt_at, last_attempt_at, sent_at, error, created_at, updated_at)
    SELECT ?, provider, channel_id, target_key, status, attempt_count,
           next_attempt_at, last_attempt_at, sent_at, error, created_at, updated_at
    FROM notification_deliveries WHERE reminder_id = ?
    ON CONFLICT(notification_id, provider, target_key) DO NOTHING
  `).run(notificationId, reminderId);
}

function inboxPayload(notification) {
  return {
    title: notification.title,
    body: notification.body,
    url: notification.url,
    notificationId: notification.id,
    tag: `notification-${notification.id}`,
    priority: 'default',
  };
}

function deliveryStillAllowed(database, notification) {
  const current = database.prepare('SELECT dismissed_at FROM notification_inbox WHERE id = ?').get(notification.id);
  if (!current || current.dismissed_at) return false;
  const isReminder = notification.source_key.startsWith('reminder:');
  if (isReminder && (notification.reminder_id == null || !database.prepare(
    'SELECT 1 FROM reminders WHERE id = ? AND dismissed = 0'
  ).get(notification.reminder_id))) return false;
  return canReceiveNotification(database, notification)
    && isNotificationDeliveryCurrent(database, notification)
    && getNotificationPreferences(database, notification.user_id)[notification.category] !== false;
}

async function runDueNotifications({
  database,
  pushService = defaultPushService,
  channelStore,
  providers = defaultProviders,
  now = new Date(),
  fetchImpl = guardedFetch,
} = {}) {
  const getDb = () => (database || dbModule.get());
  const activeDb = getDb();
  const nowIso = iso(now);
  const store = channelStore || createNotificationChannelStore({ db: activeDb });

  const users = activeDb.prepare('SELECT id FROM users').all();
  for (const user of users) {
    try {
      syncAllBirthdayReminders(activeDb, user.id, now);
    } catch (err) {
      log.error(`Birthday sync failed for user ${user.id}:`, err?.message || err);
    }
  }

  // DER BESTAND ZIEHT HIER NACH, nicht erst beim naechsten Anfassen. Der
  // Router legt die Erinnerung eines Artikels beim Speichern an - aber ein
  // Vorrat, der schon vor diesem Feature im Regal stand, ist nie gespeichert
  // worden und haette nie gemeldet. Gleiche Bauart und gleiche Stelle wie der
  // Geburtstags-Sync darueber: idempotent, ohne Zustand, bei jedem Lauf erneut.
  // Haushaltsweit statt je Nutzer - der Vorrat gehoert dem Haushalt.
  try {
    syncAllPantryExpiryReminders(activeDb, now);
  } catch (err) {
    log.error('Pantry expiry sync failed:', err?.message || err);
  }

  const due = activeDb.prepare(`
    SELECT r.id, r.created_by, r.entity_type, r.entity_id, r.remind_at, r.pushed_at,
      CASE r.entity_type
        WHEN 'task'  THEN (SELECT title FROM tasks           WHERE id = r.entity_id)
        WHEN 'event' THEN (SELECT title FROM calendar_events WHERE id = r.entity_id)
        WHEN 'subscription' THEN (SELECT name FROM budget_subscriptions WHERE id = r.entity_id)
        WHEN 'inventory_item' THEN (SELECT name FROM inventory_items WHERE id = r.entity_id)
        WHEN 'inventory_tracked_date' THEN (
          SELECT ii.name || ' · ' || d.label
          FROM inventory_item_dates d JOIN inventory_items ii ON ii.id = d.item_id
          WHERE d.id = r.entity_id
        )
        WHEN 'pantry_item' THEN (SELECT name FROM pantry_items WHERE id = r.entity_id)
        WHEN 'meal' THEN (SELECT title FROM meals WHERE id = r.entity_id)
      END AS entity_title,
      CASE WHEN r.entity_type = 'inventory_item'
        THEN (SELECT purchase_date FROM inventory_items WHERE id = r.entity_id) END AS inv_purchase_date,
      CASE WHEN r.entity_type = 'inventory_item'
        THEN (SELECT warranty_months FROM inventory_items WHERE id = r.entity_id) END AS inv_warranty_months,
      CASE WHEN r.entity_type = 'inventory_tracked_date'
        THEN (SELECT date FROM inventory_item_dates WHERE id = r.entity_id) END AS inv_tracked_date,
      CASE WHEN r.entity_type = 'pantry_item'
        THEN (SELECT expires_on FROM pantry_items WHERE id = r.entity_id) END AS pantry_expires_on,
      CASE WHEN r.entity_type = 'subscription'
        THEN (SELECT amount FROM budget_subscriptions WHERE id = r.entity_id) END AS sub_amount,
      CASE WHEN r.entity_type = 'subscription'
        THEN (SELECT currency FROM budget_subscriptions WHERE id = r.entity_id) END AS sub_currency,
      CASE WHEN r.entity_type = 'subscription'
        THEN (SELECT next_payment_date FROM budget_subscriptions WHERE id = r.entity_id)
        END AS sub_next_payment_date
    FROM reminders r
    WHERE r.dismissed = 0 AND r.pushed_at IS NULL AND r.remind_at <= ?
    ORDER BY r.remind_at ASC
  `).all(nowIso);

  const markPushed = activeDb.prepare('UPDATE reminders SET pushed_at = ? WHERE id = ?');
  // Einmal je Lauf, nicht je Meldung: die Datensprache gehoert dem Haushalt.
  const locale = resolveHouseholdLocale(activeDb);

  for (const reminder of due) {
    const payload = reminderPayload(reminder, locale);
    const notification = enqueueNotification(activeDb, {
      userId: reminder.created_by,
      sourceKey: `reminder:${reminder.id}`,
      category: { task: 'tasks', event: 'calendar', meal: 'meals' }[reminder.entity_type] || 'other',
      entityType: reminder.entity_type,
      entityId: reminder.entity_id,
      title: payload.title,
      body: payload.body,
      reminderId: reminder.id,
      // Preserve existing reminder channel scope; new personal events default
      // to user channels in the inbox service.
      deliveryScope: 'household',
    });
    if (notification) {
      importReminderDeliveries(activeDb, notification.id, reminder.id);
      // Heal a stop between the inbox completion write and legacy completion
      // marker, without replaying the successfully delivered receipt.
      if ((notification.dismissed_at || notification.dispatched_at) && !reminder.pushed_at) markPushed.run(nowIso, reminder.id);
    }
    else if (!reminder.pushed_at) markPushed.run(nowIso, reminder.id);
  }

  const pending = activeDb.prepare(`
    SELECT * FROM notification_inbox
    WHERE dispatched_at IS NULL AND dismissed_at IS NULL ORDER BY id
  `).all();
  const counters = { due: pending.length, attempted: 0, sent: 0, failed: 0, skipped: 0 };
  const complete = activeDb.prepare('UPDATE notification_inbox SET dispatched_at = ? WHERE id = ?');

  for (const notification of pending) {
    if (!deliveryStillAllowed(activeDb, notification)) {
      complete.run(nowIso, notification.id);
      if (notification.reminder_id) markPushed.run(nowIso, notification.reminder_id);
      continue;
    }
    const payload = inboxPayload(notification);
    const channels = store.listEnabledChannelsForUser(notification.user_id)
      .filter((channel) => notification.delivery_scope === 'household' || channel.scope === 'user');
    const pushCount = activeDb.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?').get(notification.user_id).c;
    const targets = [];
    if (pushCount > 0) {
      targets.push({ provider: 'webpush', channelId: null, targetKey: `user:${notification.user_id}`, send: 'webpush' });
    }
    for (const channel of channels) {
      targets.push({
        provider: channel.provider,
        channelId: channel.id,
        targetKey: `channel:${channel.id}`,
        channel,
        send: 'provider',
      });
    }

    let cancelled = false;
    const currentTargets = [];
    for (const target of targets) {
      // A previous provider was awaited. Re-read dismissal, access and source
      // state before handing this content to another external recipient.
      if (!deliveryStillAllowed(activeDb, notification)) { cancelled = true; break; }
      if (target.send === 'provider') {
        // The channel can also have changed while the previous target awaited:
        // use its current destination/secrets and honor revocation or reassignment.
        // Recheck before writing a delivery row, since deletion removes its FK.
        const channel = store.getChannel(target.channelId, { includeSecrets: true });
        const scopeAllowed = channel?.scope === 'household'
          ? notification.delivery_scope === 'household'
          : channel?.scope === 'user' && Number(channel.userId) === Number(notification.user_id);
        if (!channel?.enabled || !scopeAllowed || channel.provider !== target.provider) continue;
        target.channel = channel;
      }
      currentTargets.push(target);
      const delivery = upsertPendingDelivery(activeDb, {
        notificationId: notification.id,
        provider: target.provider,
        channelId: target.channelId,
        targetKey: target.targetKey,
        nowIso,
      });
      if (!shouldAttempt(delivery, nowIso)) continue;

      counters.attempted += 1;
      try {
        if (target.send === 'webpush') {
          const sent = await pushService.sendPushToUser(notification.user_id, {
            ...payload,
            url: `/?notification=${notification.id}`,
          });
          if (sent > 0) {
            markSent(activeDb, delivery.id, nowIso);
            counters.sent += 1;
          } else {
            markSkipped(activeDb, delivery.id, nowIso, 'No active Web Push subscriptions accepted the notification.');
            counters.skipped += 1;
          }
        } else {
          const provider = providers[target.provider];
          if (!provider) throw new Error('Unknown notification provider.');
          await withTimeout((signal) => provider.send({ channel: target.channel, payload, fetchImpl, signal }));
          markSent(activeDb, delivery.id, nowIso);
          counters.sent += 1;
        }
      } catch (err) {
        const status = markFailed(activeDb, delivery.id, now, err);
        if (status === 'skipped') counters.skipped += 1;
        else counters.failed += 1;
        log.error(`Notification delivery failed for inbox item ${notification.id}:`, safeError(err));
      }
    }

    if (cancelled || allKnownDeliveriesComplete(activeDb, notification.id, currentTargets)) {
      complete.run(nowIso, notification.id);
      if (notification.reminder_id) markPushed.run(nowIso, notification.reminder_id);
    }
  }

  if (counters.sent) log.info(`Sent ${counters.sent} notification target(s).`);
  return counters;
}

export const notificationService = createNotificationService();
