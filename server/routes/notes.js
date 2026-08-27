/**
 * Modul: Pinnwand / Notizen (Notes)
 * Zweck: REST-API-Routen für Notizen (CRUD, Pin-Toggle)
 * Abhängigkeiten: express, server/db.js, server/auth.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, color, collectErrors, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';
import { toggleChecklistLine } from '../../public/utils/markdown-checklist.js';

const log = createLogger('Notes');

const router  = express.Router();

/**
 * GET /api/v1/notes
 * Alle Notizen, angepinnte zuerst, dann nach updated_at DESC.
 * Response: { data: Note[] }
 */
router.get('/', (req, res) => {
  try {
    const notes = db.get().prepare(`
      SELECT n.*, u.display_name AS creator_name, u.avatar_color AS creator_color, u.avatar_data AS creator_avatar
      FROM notes n
      LEFT JOIN users u ON u.id = n.created_by
      ORDER BY n.pinned DESC, n.updated_at DESC
    `).all();
    res.json({ data: notes });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * POST /api/v1/notes
 * Neue Notiz anlegen.
 * Body: { content, title?, color?, pinned? }
 * Response: { data: Note }
 */
router.post('/', (req, res) => {
  try {
    const { pinned = 0 } = req.body;
    const vContent = str(req.body.content, 'Inhalt', { max: MAX_TEXT });
    const vTitle   = str(req.body.title,   'Titel',  { max: MAX_TITLE, required: false });
    const vColor   = color(req.body.color || '#FFEB3B', 'Farbe');
    const errors   = collectErrors([vContent, vTitle, vColor]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const result = db.get().prepare(`
      INSERT INTO notes (content, title, color, pinned, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(vContent.value, vTitle.value, vColor.value, pinned ? 1 : 0, req.authUserId || req.session.userId);

    const note = db.get().prepare(`
      SELECT n.*, u.display_name AS creator_name, u.avatar_color AS creator_color, u.avatar_data AS creator_avatar
      FROM notes n LEFT JOIN users u ON u.id = n.created_by
      WHERE n.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ data: note });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * PUT /api/v1/notes/:id
 * Notiz bearbeiten.
 * Body: { content?, title?, color?, pinned? }
 * Response: { data: Note }
 */
router.put('/:id', (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    const note = db.get().prepare('SELECT * FROM notes WHERE id = ?').get(id);
    if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden', code: 404 });

    const { pinned } = req.body;
    const checks = [];
    if (req.body.content !== undefined) checks.push(str(req.body.content, 'Inhalt', { max: MAX_TEXT, required: false }));
    if (req.body.title !== undefined)   checks.push(str(req.body.title,   'Titel',  { max: MAX_TITLE, required: false }));
    if (req.body.color !== undefined)   checks.push(color(req.body.color, 'Farbe'));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    db.get().prepare(`
      UPDATE notes
      SET content = COALESCE(?, content),
          title   = ?,
          color   = COALESCE(?, color),
          pinned  = COALESCE(?, pinned)
      WHERE id = ?
    `).run(
      req.body.content?.trim() ?? null,
      req.body.title !== undefined ? (req.body.title?.trim() || null) : note.title,
      req.body.color ?? null,
      pinned !== undefined ? (pinned ? 1 : 0) : null,
      id
    );

    const updated = db.get().prepare(`
      SELECT n.*, u.display_name AS creator_name, u.avatar_color AS creator_color, u.avatar_data AS creator_avatar
      FROM notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?
    `).get(id);

    res.json({ data: updated });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * PATCH /api/v1/notes/:id/pin
 * Pin-Status toggeln.
 * Response: { data: { id, pinned } }
 */
router.patch('/:id/pin', (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    const note = db.get().prepare('SELECT pinned FROM notes WHERE id = ?').get(id);
    if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden', code: 404 });

    const newPinned = note.pinned ? 0 : 1;
    db.get().prepare('UPDATE notes SET pinned = ? WHERE id = ?').run(newPinned, id);
    res.json({ data: { id, pinned: newPinned } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * PATCH /api/v1/notes/:id/check
 * Einen Checklisten-Eintrag ab- oder anhaken, ohne den Rest des Textes zu
 * berühren (#704).
 *
 * Warum das nicht über PUT läuft: PUT schreibt den ganzen `content`. Zwei
 * Mitglieder, die im selben Moment verschiedene Einträge derselben Notiz
 * abhaken, hätten damit den letzten Schreiber gewinnen lassen - der andere
 * Haken verschwände still. Hier ändert der Server genau eine Zeile des
 * gespeicherten Standes, also gehen zwei Haken in zwei Zeilen beide durch.
 *
 * Adressiert wird über die Zeilennummer, die der Renderer am Kästchen
 * hinterlässt, nicht über den Eintragstext: zwei Zeilen „Milch" sind sonst
 * nicht auseinanderzuhalten. `expect` ist die Gegenprobe dazu - stimmt die
 * Zeile nicht mehr mit der überein, die der Client gesehen hat, hat jemand den
 * Text bearbeitet und der Index zeigt woanders hin. Dann lieber 409 als ein
 * Haken in der falschen Zeile.
 *
 * Body: { line: number, checked: boolean, expect?: string }
 * Response: { data: Note } | 409 { code: 409, reason }
 */
router.patch('/:id/check', (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    const note = db.get().prepare('SELECT * FROM notes WHERE id = ?').get(id);
    if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden', code: 404 });

    const { line, checked, expect } = req.body;
    if (!Number.isInteger(line) || line < 0)
      return res.status(400).json({ error: 'Ungültige Zeilennummer.', code: 400 });
    if (typeof checked !== 'boolean')
      return res.status(400).json({ error: 'Ungültiger Zustand.', code: 400 });
    if (expect !== undefined && expect !== null && typeof expect !== 'string')
      return res.status(400).json({ error: 'Ungültige Zeilenprüfung.', code: 400 });

    const result = toggleChecklistLine(note.content, line, checked, expect);
    if (!result.ok) {
      return res.status(409).json({
        error: 'Die Notiz hat sich inzwischen geändert.',
        code:  409,
        reason: result.reason,
      });
    }

    // `changed: false` heißt, der Eintrag stand schon so - dann bleibt auch
    // `updated_at` unangetastet, sonst sortierte ein folgenloser Tap die
    // Pinnwand um.
    if (result.changed) {
      db.get().prepare('UPDATE notes SET content = ? WHERE id = ?').run(result.content, id);
    }

    const updated = db.get().prepare(`
      SELECT n.*, u.display_name AS creator_name, u.avatar_color AS creator_color, u.avatar_data AS creator_avatar
      FROM notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?
    `).get(id);

    res.json({ data: updated });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * DELETE /api/v1/notes/:id
 * Notiz löschen.
 * Response: 204 No Content
 */
router.delete('/:id', (req, res) => {
  try {
    const id     = parseInt(req.params.id, 10);
    const result = db.get().prepare('DELETE FROM notes WHERE id = ?').run(id);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Notiz nicht gefunden', code: 404 });
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
