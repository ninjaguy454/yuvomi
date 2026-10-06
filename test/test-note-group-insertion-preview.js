import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoteGroupInsertionPreview } from '../public/utils/note-drag-motion.js';

// A layout-only fixture keeps insertion arithmetic independent of animated
// rectangles. Native browser coverage separately exercises real grid/touch DOM.
function fixture({ count = 10, columns = 3, rtl = false, reduced = false, width = 320 } = {}) {
  const pitch = width + 16, contentWidth = columns * pitch - 16;
  const members = Array.from({ length: count }, (_, index) => index + 1);
  const animationCalls = [];
  const document = { createElement: () => new Card(), defaultView: {
    matchMedia: () => ({ matches: reduced }),
    getComputedStyle: () => ({ height: '604px', paddingLeft: '4px', paddingRight: '4px', paddingTop: '4px',
      gridTemplateColumns: Array(columns).fill(`${width}px`).join(' '), columnGap: '16px', rowGap: '16px', direction: rtl ? 'rtl' : 'ltr' }),
  } };
  class Card {
    constructor(id) {
      this.dataset = id ? { groupPage: String(id) } : {}; this.hidden = false; this.inert = false;
      this.ownerDocument = document; this.offsetWidth = width; this.offsetHeight = 276;
      this.style = { order: '', getPropertyValue(name) { return this[name] || ''; }, getPropertyPriority() { return ''; },
        setProperty(name, value) { this[name] = value; }, removeProperty(name) { this[name] = ''; } };
      this.animatedX = 0; this.animatedY = 0;
    }
    hasAttribute(name) { return name === 'data-group-page' && this.dataset.groupPage !== undefined; }
    setAttribute() {}
    remove() { if (!this.parentElement) return; this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
    getBoundingClientRect() {
      const index = ordered().indexOf(this), column = index % columns;
      const left = 104 + (rtl ? contentWidth - width - column * pitch : column * pitch) + this.animatedX;
      const top = 104 + Math.floor(index / columns) * 292 - grid.scrollTop + this.animatedY;
      return { left, right: left + width, top, bottom: top + 276, width, height: 276 };
    }
    animate(keyframes, options) {
      const animation = { keyframes, options, cancelled: false, finished: new Promise(() => {}),
        cancel: () => { animation.cancelled = true; this.animatedX = 0; this.animatedY = 0; } };
      animationCalls.push(animation); return animation;
    }
  }
  const grid = { ownerDocument: document, children: [], dataset: {}, scrollTop: 0, style: new Card().style,
    offsetWidth: contentWidth + 24, clientWidth: contentWidth + 8, clientLeft: rtl ? 16 : 0, clientTop: 0,
    append(...nodes) { nodes.forEach(node => { node.parentElement = this; this.children.push(node); }); },
    getBoundingClientRect: () => ({ left: 100, right: 100 + contentWidth + 24, top: 100, bottom: 704, width: contentWidth + 24, height: 604 }),
  };
  const ordered = () => grid.children.filter(node => !node.hidden).sort((a, b) => Number(a.style.order) - Number(b.style.order));
  grid.append(...members.map(id => new Card(id)));
  const originals = [...grid.children];
  const preview = createNoteGroupInsertionPreview(grid);
  const point = (slot, after = false) => {
    const column = slot % columns, inline = column * pitch + (after ? width * .8 : width * .2);
    return { clientX: 104 + grid.clientLeft + (rtl ? contentWidth - inline : inline), clientY: 104 + Math.floor(slot / columns) * 292 + 70 - grid.scrollTop };
  };
  return { grid, members, originals, preview, animationCalls, point, ordered,
    update(selectedIds, slot, after = false) { return preview.update({ memberIds: members, selectedIds, ...point(slot, after) }); },
    gaps: () => grid.children.filter(node => node.dataset.groupInsertionGap !== undefined),
  };
}

test('selection slots retain click order, full card size and the connected native target', () => {
  const f = fixture(), originalOrder = [...f.grid.children];
  assert.deepEqual(f.update([5, 2], 1), { before_note_id: 3 });
  assert.deepEqual(f.gaps().map(node => node.dataset.groupInsertionGap), ['5', '2']);
  assert.ok(f.gaps().every(node => node.offsetHeight === 276 && node.offsetWidth === 320));
  assert.ok([f.originals[4], f.originals[1]].every(node => node.hidden && node.inert && node.parentElement === f.grid));
  assert.deepEqual(f.grid.children.filter(node => node.dataset.groupPage), originalOrder);
  assert.deepEqual(f.members, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  f.preview.clear();
  assert.deepEqual(f.grid.children, originalOrder);
  assert.ok(f.originals.every(node => !node.hidden && !node.inert && !node.style.order));
});

for (const rtl of [false, true]) test(`row wrapping uses stable slots while cards animate (${rtl ? 'RTL' : 'LTR'})`, () => {
  const f = fixture({ rtl }); f.update([2, 5], 1);
  assert.deepEqual(f.update([2, 5], 5, true), { before_note_id: 7 });
  f.originals.forEach(card => { card.animatedX = 200; card.animatedY = -200; });
  for (let i = 0; i < 20; i++) assert.deepEqual(f.update([2, 5], 5, true), { before_note_id: 7 });
  assert.equal(f.grid.dataset.groupInsertionBefore, '7');
  assert.deepEqual(f.update([2, 5], 0), { before_note_id: 1 });
  f.grid.scrollTop = 584;
  assert.deepEqual(f.update([2, 5], 11, true), { before_note_id: null });
  assert.equal(f.grid.dataset.groupInsertionBefore, '');
});

test('external selections reserve every slot and leaving restores owned state', () => {
  const f = fixture({ count: 4 }); f.originals[0].inert = true; f.originals[0].style.order = '8';
  f.grid.style.height = '75%';
  f.grid.dataset.groupInsertionBefore = 'prior';
  f.update([21, 22, 23], 0);
  assert.equal(f.grid.style.height, '604px', 'incoming rows retain the current used height during the gesture');
  assert.equal(f.gaps().length, 3);
  assert.ok(f.originals.every(card => !card.hidden));
  assert.equal(f.preview.update({ memberIds: f.members, selectedIds: [21, 22, 23], clientX: 0, clientY: 0 }), null);
  assert.equal(f.gaps().length, 0);
  assert.equal(f.originals[0].style.order, '8'); assert.equal(f.originals[0].inert, true);
  assert.equal(f.grid.dataset.groupInsertionBefore, 'prior');
  assert.equal(f.grid.style.height, '75%', 'leaving restores the original responsive height');
});

test('responsive single-column slots include scroll position and partial row end', () => {
  const f = fixture({ count: 8, columns: 1, width: 260 });
  f.update([2], 0); f.grid.scrollTop = 1168;
  assert.deepEqual(f.update([2], 5, true), { before_note_id: 7 });
  f.grid.scrollTop = 1752;
  assert.deepEqual(f.update([2], 7, true), { before_note_id: null });
  assert.equal(f.gaps()[0].offsetWidth, 260);
});

test('retargeting and cancellation remove animations; reduced motion never starts one', () => {
  const f = fixture(); f.update([2], 1); f.update([2], 5, true);
  assert.ok(f.animationCalls.length > 0);
  const first = [...f.animationCalls]; f.update([2], 0);
  assert.ok(first.every(animation => animation.cancelled));
  f.preview.clear(); assert.ok(f.animationCalls.every(animation => animation.cancelled));
  const reduced = fixture({ reduced: true }); reduced.update([2], 1); reduced.update([2], 5, true);
  assert.equal(reduced.animationCalls.length, 0); assert.equal(reduced.grid.dataset.groupInsertionBefore, '7');
});

test('reconciliation cannot revive removed content and disposal is final', () => {
  const f = fixture(); f.update([2], 1);
  const removed = f.originals[1]; removed.remove(); f.members.splice(1, 1);
  f.update([3], 1); assert.equal(removed.parentElement, null);
  assert.equal(f.grid.children.includes(removed), false);
  f.preview.dispose(); f.preview.dispose();
  assert.equal(f.update([3], 0), null); assert.equal(f.gaps().length, 0);
});
