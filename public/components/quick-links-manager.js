/**
 * Modul: Schnellzugriffe verwalten (#469)
 * Zweck: Der Dialog hinter der Kachelreihe auf der Übersicht - anlegen, ändern,
 *        sortieren, löschen.
 * Abhängigkeiten: /api.js, /components/modal.js, /utils/quick-link-url.js
 *
 * WARUM DIE VERWALTUNG IM DIALOG WOHNT UND NICHT AUF EINER SEITE. Die Reihe ist
 * ausdrücklich kein Modul (#469): sie bekommt keinen Navigationseintrag, weil
 * eine Seite, auf der man drei Links pflegt, die Leiste teurer macht als sie
 * wert ist. Wer die Kacheln sieht, ist schon dort, wo sie hingehören - der Weg
 * zur Pflege geht deshalb von der Kachel aus.
 *
 * DIE ADRESSE PRUEFT DER BROWSER MIT DERSELBEN FUNKTION WIE DER SERVER
 * (/utils/quick-link-url.js). Das Formular widerspricht damit sofort statt nach
 * dem Absenden, und beide sagen dasselbe - eine eigene Regel hier wäre die
 * zweite Wahrheit, und sie liefe genau bei den Eingaben auseinander, auf die
 * es ankommt.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { AVATAR_COLORS } from '/utils/color.js';
import { prefersInkText } from '/utils/contrast.js';
import { openModal, closeModal, confirmOverModal, reportFieldError, btnError } from '/components/modal.js';
import { normalizeQuickLinkUrl, quickLinkHost } from '/utils/quick-link-url.js';
import { makeSortable } from '/utils/sortable.js';

/** Dieselben Werte wie in server/routes/quick-links.js. */
const VISIBILITY_VALUES = ['all', 'private'];

/**
 * So groß darf ein Kachelbild werden - derselbe Deckel wie im Server
 * (server/routes/quick-links.js), wo auch die Begründung steht. Der Zuschnitt
 * liefert 20 bis 40 KB; diese Zahl fängt die Ausreißer ab, bevor sie über die
 * Leitung gehen.
 */
const MAX_ICON_DATA_LENGTH = 128 * 1024;

const ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * Die Absage der Adressprüfung als Satz, den jemand lesen kann.
 *
 * ALS TABELLE MIT AUSGESCHRIEBENEN SCHLUESSELN und nicht als ein aus dem Grund
 * zusammengesetzter Name: ein zur Laufzeit gebauter Schlüssel ist für jeden
 * Guard unsichtbar, der die Locale-Dateien gegen die Aufrufstellen hält - er
 * fände ihn nie, meldete die vier Schlüssel als unbenutzt, und ein fehlender
 * vierter stünde als `undefined` in der Oberfläche, ohne dass ein Test das sieht.
 * (Der Guard, der das prüft, hat diese Zeile beim ersten Anlauf selbst
 * angemahnt - er las den Beispielnamen im Kommentar als Aufrufstelle.)
 */
const URL_ERROR_KEYS = {
  'empty':     'quickLinks.urlRequired',
  'too-long':  'quickLinks.urlTooLong',
  'protocol':  'quickLinks.urlProtocol',
  'malformed': 'quickLinks.urlInvalid',
};

/**
 * Die Farben, aus denen eine Kachel ohne Bild ihren Grund bekommt. Es sind die
 * Farben, aus denen auch ein Mitglied ohne Foto seine bekommt (utils/color.js):
 * eine Kachel neben einem Mitgliedsbild soll aus derselben Palette sprechen.
 */
const TILE_COLORS = AVATAR_COLORS;

function monogram(name) {
  // Der erste BUCHSTABE, nicht das erste Zeichen: ein Name wie "🎬 Jellyfin"
  // ergäbe sonst eine Kachel, die auf jedem Gerät anders aussieht.
  const match = String(name ?? '').match(/\p{L}|\p{N}/u);
  return (match ? match[0] : '?').toUpperCase();
}

function faceInner(iconData, name) {
  return iconData
    ? `<img src="${esc(iconData)}" alt="">`
    : `<span class="quick-link-face__monogram">${esc(monogram(name))}</span>`;
}

/**
 * Die Klasse, die dem Gesicht seine lesbare Schriftfarbe gibt.
 * Weiss auf einer frei gewaehlten Farbe haelt WCAG AA nicht durchgehend -
 * dieselbe Messung, die die Avatar-Initialen einmal gekostet hat.
 */
function faceInk(color) {
  return prefersInkText(color) ? ' quick-link-face--ink' : '';
}

/**
 * Liest eine Bilddatei und lässt sie zuschneiden.
 * Nutzt denselben Zuschnitt-Dialog wie das Mitgliedsfoto - ein zweiter wäre
 * dieselbe Arbeit mit einer zweiten Bedienung.
 * @returns {Promise<string|undefined>} Data-URL, oder undefined bei Abbruch
 */
async function readIconAsDataUrl(file) {
  if (!file) return undefined;
  if (!ICON_TYPES.includes(file.type)) throw new Error(t('quickLinks.iconTypeError'));

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(t('quickLinks.iconReadError')));
    reader.readAsDataURL(file);
  });

  const { openCropDialog } = await import('/utils/avatar-crop.js');
  const cropped = await openCropDialog(dataUrl);
  if (cropped === null) return undefined;
  if (cropped.length > MAX_ICON_DATA_LENGTH) throw new Error(t('quickLinks.iconTooLarge'));
  return cropped;
}

// --------------------------------------------------------
// Formular für eine Kachel
// --------------------------------------------------------

function formHtml(state, isEdit) {
  const swatches = TILE_COLORS.map((c) => `
    <button type="button" class="quick-link-swatch ${state.color === c ? 'quick-link-swatch--active' : ''}"
            data-color="${esc(c)}" style="--swatch:${esc(c)}"
            role="radio" aria-checked="${state.color === c ? 'true' : 'false'}"
            tabindex="${state.color === c ? '0' : '-1'}"
            aria-label="${esc(t('quickLinks.colorOption', { color: c }))}"></button>`).join('');

  return `
    <div class="quick-link-form">
      <div class="quick-link-form__face">
        <button type="button" class="quick-link-face quick-link-face--lg${faceInk(state.color)}" id="quick-link-icon-trigger"
                style="--quick-link-color:${esc(state.color)}"
                aria-label="${esc(t('quickLinks.iconPick'))}">
          ${faceInner(state.iconData, state.name)}
        </button>
        <div class="quick-link-form__face-actions">
          <button type="button" class="btn btn--secondary btn--sm" id="quick-link-icon-pick">
            ${esc(t('quickLinks.iconPick'))}
          </button>
          <button type="button" class="btn btn--ghost btn--sm" id="quick-link-icon-clear"
                  ${state.iconData ? '' : 'hidden'}>
            ${esc(t('quickLinks.iconClear'))}
          </button>
        </div>
        <p class="form-hint">${esc(t('quickLinks.iconHint'))}</p>
        <input type="file" id="quick-link-icon-file" accept="image/png,image/jpeg,image/webp" hidden>
      </div>

      <div class="form-group">
        <label class="form-label" for="quick-link-name">${esc(t('quickLinks.nameLabel'))}</label>
        <input type="text" class="form-input" id="quick-link-name" maxlength="100"
               value="${esc(state.name)}" placeholder="${esc(t('quickLinks.namePlaceholder'))}">
      </div>

      <div class="form-group">
        <label class="form-label" for="quick-link-url">${esc(t('quickLinks.urlLabel'))}</label>
        <input type="text" class="form-input" id="quick-link-url" inputmode="url"
               value="${esc(state.url)}" placeholder="${esc(t('quickLinks.urlPlaceholder'))}">
        <p class="form-hint">${esc(t('quickLinks.urlHint'))}</p>
      </div>

      <div class="form-group">
        <span class="form-label" id="quick-link-color-label">${esc(t('quickLinks.colorLabel'))}</span>
        <div class="quick-link-swatches" role="radiogroup" aria-labelledby="quick-link-color-label">${swatches}</div>
      </div>

      <div class="form-group">
        <label class="form-label" for="quick-link-visibility">${esc(t('quickLinks.visibilityLabel'))}</label>
        <select class="form-input" id="quick-link-visibility">
          <option value="all" ${state.visibility === 'all' ? 'selected' : ''}>${esc(t('quickLinks.visibilityAll'))}</option>
          <option value="private" ${state.visibility === 'private' ? 'selected' : ''}>${esc(t('quickLinks.visibilityPrivate'))}</option>
        </select>
        <p class="form-hint">${esc(t('quickLinks.visibilityHint'))}</p>
      </div>
    </div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      ${isEdit
    ? `<button type="button" class="btn btn--danger-outline" id="quick-link-delete" style="margin-right:auto">${esc(t('common.delete'))}</button>`
    : ''}
      <button type="button" class="btn btn--secondary" id="quick-link-cancel">${esc(t('common.cancel'))}</button>
      <button type="button" class="btn btn--primary" id="quick-link-save">${esc(isEdit ? t('common.save') : t('common.create'))}</button>
    </div>`;
}

/**
 * Formular für eine neue oder bestehende Kachel.
 * @param {object|null} link  null = neu
 * @param {Function} onDone       nach erfolgreichem Speichern
 */
function openQuickLinkForm(link, onDone) {
  const isEdit = Boolean(link);
  const state = {
    name: link?.name ?? '',
    url: link?.url ?? '',
    iconData: link?.icon_data ?? null,
    color: link?.color ?? TILE_COLORS[0],
    visibility: VISIBILITY_VALUES.includes(link?.visibility) ? link.visibility : 'all',
  };

  openModal({
    title: isEdit ? t('quickLinks.editTitle') : t('quickLinks.addTitle'),
    size: 'sm',
    content: formHtml(state, isEdit),
    onSave(panel) {
      const face = panel.querySelector('#quick-link-icon-trigger');
      const fileInput = panel.querySelector('#quick-link-icon-file');
      const clearBtn = panel.querySelector('#quick-link-icon-clear');
      const nameInput = panel.querySelector('#quick-link-name');

      const repaintFace = () => {
        face.style.setProperty('--quick-link-color', state.color);
        face.classList.toggle('quick-link-face--ink', prefersInkText(state.color));
        face.replaceChildren();
        face.insertAdjacentHTML('afterbegin', faceInner(state.iconData, state.name));
        clearBtn.hidden = !state.iconData;
      };

      // Der Buchstabe folgt dem Namen beim Tippen: die Vorschau ist die Kachel,
      // die gleich auf der Übersicht steht, und nicht ihr Platzhalter.
      nameInput.addEventListener('input', (e) => {
        state.name = e.target.value;
        if (!state.iconData) repaintFace();
      });

      [face, panel.querySelector('#quick-link-icon-pick')].forEach((el) => {
        el.addEventListener('click', () => fileInput.click());
      });

      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        try {
          const data = await readIconAsDataUrl(file);
          if (data === undefined) return;
          state.iconData = data;
          repaintFace();
        } catch (err) {
          window.yuvomi?.showToast(err.message, 'danger');
        }
      });

      clearBtn.addEventListener('click', () => {
        state.iconData = null;
        repaintFace();
      });

      // Farbwahl mit Roving Tabindex - dasselbe Muster wie die Notizfarben.
      const swatches = [...panel.querySelectorAll('.quick-link-swatch')];
      const selectSwatch = (target) => {
        swatches.forEach((s) => {
          const active = s === target;
          s.classList.toggle('quick-link-swatch--active', active);
          s.setAttribute('aria-checked', active ? 'true' : 'false');
          s.setAttribute('tabindex', active ? '0' : '-1');
        });
        state.color = target.dataset.color;
        repaintFace();
      };
      swatches.forEach((sw) => {
        sw.addEventListener('click', () => { selectSwatch(sw); sw.focus(); });
        sw.addEventListener('keydown', (e) => {
          const idx = swatches.indexOf(sw);
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = swatches[(idx + 1) % swatches.length];
            selectSwatch(next); next.focus();
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = swatches[(idx - 1 + swatches.length) % swatches.length];
            selectSwatch(prev); prev.focus();
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectSwatch(sw);
          }
        });
      });

      panel.querySelector('#quick-link-cancel').addEventListener('click', () => closeModal());

      panel.querySelector('#quick-link-delete')?.addEventListener('click', async () => {
        // OHNE `danger: true`, und das ist eine Entscheidung: die Warnfarbe ist
        // für Handlungen reserviert, die etwas zerstören, das nicht
        // wiederkommt. Ein gelöschter Link ist ein Name und eine Adresse - in
        // zehn Sekunden wieder eingetippt. Wer hier rot einfärbt, entwertet das
        // Rot an den Stellen, an denen es zählt.
        //
        // `confirmOverModal` statt `confirmModal`, weil dieser Dialog über
        // einem offenen Modal aufgeht: er parkt es, statt es zu verdrängen -
        // und schließt es selbst, sobald bestätigt wurde.
        const ok = await confirmOverModal(t('quickLinks.deleteConfirm', { name: link.name }));
        if (!ok) return;
        try {
          await api.delete(`/quick-links/${link.id}`);
          window.yuvomi?.showToast(t('quickLinks.deleted'), 'success');
          await onDone();
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
        }
      });

      const saveBtn = panel.querySelector('#quick-link-save');
      saveBtn.addEventListener('click', async () => {
        const urlInput = panel.querySelector('#quick-link-url');
        const name = nameInput.value.trim();
        const rawUrl = urlInput.value.trim();

        if (!name) return reportFieldError(nameInput, t('quickLinks.nameRequired'));
        // Dieselbe Prüfung wie im Server, aus derselben Datei.
        const parsed = normalizeQuickLinkUrl(rawUrl);
        if (!parsed.ok) return reportFieldError(urlInput, t(URL_ERROR_KEYS[parsed.reason] ?? URL_ERROR_KEYS.malformed));

        const body = {
          name,
          url: parsed.url,
          icon_data: state.iconData,
          color: state.color,
          visibility: panel.querySelector('#quick-link-visibility').value,
        };

        const label = saveBtn.textContent;
        saveBtn.disabled = true;
        saveBtn.textContent = '…';
        try {
          if (isEdit) await api.put(`/quick-links/${link.id}`, body);
          else await api.post('/quick-links', body);
          closeModal({ force: true });
          window.yuvomi?.showToast(isEdit ? t('quickLinks.saved') : t('quickLinks.added'), 'success');
          await onDone();
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
          btnError(saveBtn);
          saveBtn.disabled = false;
          saveBtn.textContent = label;
        }
      });
    },
  });
}

// --------------------------------------------------------
// Übersicht der Kacheln
// --------------------------------------------------------

function listRowHtml(s, canEdit) {
  const host = quickLinkHost(s.url);
  return `
    <li class="quick-link-manage-row" data-id="${s.id}">
      <span class="quick-link-manage-row__handle" data-sortable-handle aria-hidden="true">
        <i data-lucide="grip-vertical"></i>
      </span>
      <span class="quick-link-face${faceInk(s.color || TILE_COLORS[0])}" style="--quick-link-color:${esc(s.color || TILE_COLORS[0])}">${faceInner(s.icon_data, s.name)}</span>
      <span class="quick-link-manage-row__body">
        <span class="quick-link-manage-row__name">${esc(s.name)}</span>
        <span class="quick-link-manage-row__host">${esc(host)}</span>
      </span>
      ${s.visibility === 'private'
    ? `<i data-lucide="lock" class="quick-link-manage-row__private" aria-label="${esc(t('quickLinks.privateBadge'))}"></i>`
    : ''}
      ${canEdit
    ? `<button type="button" class="btn-icon" data-edit="${s.id}" aria-label="${esc(t('quickLinks.editOne', { name: s.name }))}">
             <i data-lucide="pencil"></i>
           </button>`
    // EINE FREMDE KACHEL IST SICHTBAR, ABER NICHT BEARBEITBAR, und das steht
    // hier auch so da. Ein Knopf, den der Server mit 403 beantwortet, wäre die
    // schlechtere Auskunft als gar keiner.
    : `<span class="quick-link-manage-row__locked">${esc(t('quickLinks.notYours'))}</span>`}
    </li>`;
}

/**
 * Öffnet die Verwaltung.
 * @param {object} opts
 * @param {Function} opts.onChange  nach jeder Änderung (Übersicht neu laden)
 */
export async function openQuickLinksManager({ onChange = () => {} } = {}) {
  let items = [];
  try {
    items = (await api.get('/quick-links'))?.data ?? [];
  } catch {
    window.yuvomi?.showToast(t('quickLinks.loadError'), 'danger');
    return;
  }

  // Nach einer Änderung zeigt die Verwaltung wieder den neuen Stand - sonst
  // stünde die Liste, aus der man gerade gelöscht hat, unverändert da.
  const reload = async () => {
    await onChange();
    await openQuickLinksManager({ onChange });
  };

  const body = items.length
    ? `<ul class="quick-link-manage-list" id="quick-link-manage-list">${items.map((s) => listRowHtml(s, s.can_edit)).join('')}</ul>`
    : `<p class="quick-link-manage-empty">${esc(t('quickLinks.emptyManage'))}</p>`;

  openModal({
    title: t('quickLinks.manageTitle'),
    size: 'sm',
    content: `
      ${body}
      <button type="button" class="btn btn--secondary quick-link-manage-add" id="quick-link-add">
        <i data-lucide="plus" aria-hidden="true"></i>
        <span>${esc(t('quickLinks.add'))}</span>
      </button>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--secondary" id="quick-link-manage-close">${esc(t('common.close'))}</button>
      </div>`,
    onSave(panel) {
      panel.querySelector('#quick-link-manage-close').addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('#quick-link-add').addEventListener('click', () => openQuickLinkForm(null, reload));

      panel.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const s = items.find((x) => String(x.id) === btn.dataset.edit);
          if (s) openQuickLinkForm(s, reload);
        });
      });

      const list = panel.querySelector('#quick-link-manage-list');
      if (!list) return;
      makeSortable(list, {
        handle: '[data-sortable-handle]',
        draggable: '.quick-link-manage-row',
        onEnd: async () => {
          // Die Reihenfolge gilt für den ganzen Haushalt, nicht pro Person: es
          // ist EINE Reihe, und zwei Mitglieder, die sie verschieden sortieren,
          // hätten zwei Wahrheiten über dieselben Kacheln. Wer eine eigene
          // Ordnung will, hat dafür die privaten Kacheln.
          //
          // Gelesen wird die Reihenfolge aus dem DOM und nicht aus dem Event:
          // `oldIndex`/`newIndex` beschreiben EINEN Zug, die Liste danach ist
          // die Wahrheit - und genau sie schickt der Server zurück.
          const ids = [...list.querySelectorAll('.quick-link-manage-row')]
            .map((li) => Number(li.dataset.id))
            .filter(Number.isInteger);
          try {
            await api.put('/quick-links/order', { ids });
            await onChange();
          } catch {
            window.yuvomi?.showToast(t('quickLinks.orderError'), 'danger');
          }
        },
      });
    },
  });
}
