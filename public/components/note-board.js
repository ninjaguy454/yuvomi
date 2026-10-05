import { NOTE_COLUMNS, NOTE_ROW_HEIGHT, normalizeNoteLayout, projectNoteLayouts, noteCanvasExtent, noteGroupArrangeItem } from '/utils/note-board-layout.js';
import { t } from '/i18n.js';

/** Keep the active content card's note identity distinct from its geometry owner. */
export function renderNoteGroupFrame(item, cardHtml) {
  const template = document.createElement('template');
  template.innerHTML = cardHtml;
  const card = template.content.firstElementChild;
  card.dataset.boardKey = item.key;
  card.dataset.boardKind = item.kind;
  if (item.kind === 'group') {
    card.dataset.groupId = String(item.id);
    card.classList.add('note-card--group');
    if (item.member_ids.length > 1) {
      const pager = document.createElement('div');
      pager.className = 'note-group-pages';
      pager.setAttribute('role', 'group');
      pager.setAttribute('aria-label', t('notes.groupPages'));
      const index = item.member_ids.indexOf(item.note.id);
      for (const [action, label, text, disabled] of [
        ['previous',t('notes.groupPrevious'),'‹',index === 0],
        ['overview',t('notes.groupOverview',{current:index+1,count:item.member_ids.length}),`${index+1} / ${item.member_ids.length}`,false],
        ['next',t('notes.groupNext'),'›',index === item.member_ids.length-1],
      ]) {
        const button = document.createElement('button');
        button.type='button'; button.dataset.groupPage=action; button.textContent=text;
        button.setAttribute('aria-label',label); button.disabled=disabled;
        pager.append(button);
      }
      card.prepend(pager);
    }
  }
  return template.innerHTML;
}

/** Layout changes commit only after an intentional completed gesture. */
export function wireNoteBoard(grid, { getNotes = () => [], canEdit = () => true, saveLayout, getBoardItems, saveBoardCommand,
  activePages = new Map(), groupDragBridge, onGroupAction = () => {}, compact = false, filtered = false, viewState = {}, onViewChange = () => {} }) {
  const viewport = grid.closest('.notes-scroll'), space = grid.parentElement;
  const revealStrip = grid.closest('.notes-page')?.querySelector('.notes-reveal-strip');
  let revealIds = [];
  const viewportWidth = () => viewport.clientWidth - (parseFloat(getComputedStyle(viewport).paddingLeft) || 0) - (parseFloat(getComputedStyle(viewport).paddingRight) || 0);
  let disposed = false, gesture = null, narrow = compact || viewportWidth() < 640;
  let suppressClick = false, frame = 0, excludedPointer = null;
  let navigation = null;
  const touches = new Map();
  viewState.zoom ??= 1;
  viewState.order ??= [];
  const zoom = () => narrow ? 1 : viewState.zoom;
  const pending = new Set();
  const items = () => getBoardItems ? getBoardItems() : projectNoteLayouts(getNotes(), { filtered }).map(value => {
    const note = getNotes().find(note => note.id === value.note_id);
    return { key:`note:${note.id}`, kind:'note', id:note.id, note, layout:{...value.layout,
      position_locked:!!note.layout?.position_locked,always_on_top:!!note.layout?.always_on_top},can_manage:note.permissions?.arrange!==false && canEdit(note) };
  });
  const cardFor = item => grid.querySelector(`[data-board-key="${item.key}"]`)
    || (item.kind === 'note' ? grid.querySelector(`.note-card[data-id="${item.id}"]`) : null);
  const itemFor = card => items().find(item => item.key === card?.dataset.boardKey
    || (!card?.dataset.boardKey && item.kind === 'note' && item.id === Number(card?.dataset.id)));
  const editable = item => item && !filtered && (item.kind === 'group' ? item.can_manage === true
    : item.can_manage!==false && item.note.permissions?.arrange!==false && canEdit(item.note));
  const commandFor = (item, layout) => ({ kind:'arrange',items:[noteGroupArrangeItem(item,layout)],include_locked:true });
  let adopted = null, hoverKey = null, waitingForBridge = false, interactionGeneration = 0;
  const gap = () => parseFloat(getComputedStyle(grid).getPropertyValue('--space-3')) || 12;
  function paint(card, layout) {
    const pitch = viewportWidth() / NOTE_COLUMNS;
    Object.assign(card.style, { left: `${layout.x * pitch}px`, top: `${layout.y * NOTE_ROW_HEIGHT}px`, width: `${layout.width * pitch - gap()}px`, height: `${layout.height * NOTE_ROW_HEIGHT - gap()}px` });
  }
  function layerCards(selectedId) {
    const notes = items(), ids = notes.map(note => note.key);
    viewState.order = [...viewState.order.filter(id => ids.includes(id)), ...ids.filter(id => !viewState.order.includes(id))];
    if (selectedId) viewState.order = [...viewState.order.filter(id => id !== selectedId), selectedId];
    if (selectedId && selectedId !== `note:${viewState.revealed}`) viewState.revealed = null;
    for (const note of notes) {
      const card = cardFor(note);
      if (card) card.style.zIndex = String(gesture?.active && gesture.item.key === note.key ? notes.length * 2 + 3
        : card.querySelector('.note-card__menu[open]') ? notes.length * 2 + 2
        : note.kind === 'note' && viewState.revealed === note.id ? notes.length * 2 + 1
        : (note.layout?.always_on_top ? notes.length : 0) + viewState.order.indexOf(note.key) + 1);
    }
    revealStrip?.querySelectorAll('[data-note-reveal]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.noteReveal) === viewState.revealed)));
  }
  function revealTabs(projected) {
    if (!revealStrip) return;
    const focused = revealStrip.contains(document.activeElement) ? Number(document.activeElement.dataset.noteReveal) : viewState.revealFocus;
    revealIds = narrow ? [] : projected.filter(item => item.kind === 'note' && item.layout.position_locked && projected.some(other =>
      item.key !== other.key && item.layout.x < other.layout.x + other.layout.width && item.layout.x + item.layout.width > other.layout.x
      && item.layout.y < other.layout.y + other.layout.height && item.layout.y + item.layout.height > other.layout.y)).map(item => item.id);
    if (!revealIds.includes(viewState.revealed)) viewState.revealed = null;
    const buttons = getNotes().filter(note => revealIds.includes(note.id)).map(note => {
      const button = document.createElement('button'), label = document.createElement('span');
      const title = note.title?.trim() || t('notes.untitledNote');
      button.type = 'button'; button.className = 'notes-reveal-tab'; button.dataset.noteReveal = String(note.id);
      button.setAttribute('aria-label', t('notes.revealNote', { title })); button.title = title;
      const card = grid.querySelector(`.note-card[data-id="${note.id}"]`);
      if (card) { card.id = `notes-board-card-${note.id}`; button.setAttribute('aria-controls', card.id); }
      label.className = 'notes-reveal-tab__label'; label.textContent = title; button.append(label);
      return button;
    });
    revealStrip.hidden = !buttons.length; revealStrip.replaceChildren(...buttons);
    if (focused) {
      const target = buttons.find(button => Number(button.dataset.noteReveal) === focused)
        || (narrow ? grid.querySelector(`.note-card[data-id="${focused}"] [data-action="open"]`) : null);
      target?.focus({ preventScroll: true });
    }
    viewState.revealFocus = null;
  }
  function reveal(event) {
    const button = event.target.closest('[data-note-reveal]');
    if (!button || !revealStrip.contains(button) || disposed) return;
    const id = Number(button.dataset.noteReveal);
    if (!revealIds.includes(id)) return;
    cancel(); viewState.revealed = viewState.revealed === id ? null : id; layerCards();
    if (viewState.revealed) {
      const card = grid.querySelector(`.note-card[data-id="${id}"]`), bounds = viewport.getBoundingClientRect();
      if (card) {
        const rect = card.getBoundingClientRect();
        const scroller = scrollParent(card), top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
        viewport.scrollLeft += rect.left - bounds.left - 12;
        scroller.scrollTop += rect.top - top - 12;
      }
    }
  }
  function revealFocus(event) {
    const button = event.target.closest('[data-note-reveal]');
    if (!button || !revealStrip.contains(button)) return;
    // Native focus scrolling may expose only part of a flex item. Keep the
    // complete target visible without scrolling the shell or canvas.
    const bounds = revealStrip.getBoundingClientRect(), rect = button.getBoundingClientRect();
    if (rect.left < bounds.left) revealStrip.scrollLeft += rect.left - bounds.left;
    else if (rect.right > bounds.right) revealStrip.scrollLeft += rect.right - bounds.right;
  }
  function cardFocus(event) {
    const card = event.target.closest('.note-card');
    if (card) layerCards(itemFor(card)?.key);
  }
  function extent(layouts) {
    if (narrow) return;
    grid.style.setProperty('--note-group-ui-scale',String(1/zoom()));
    const value = noteCanvasExtent(layouts, viewportWidth(), Math.max(320, viewport.clientHeight - 12) / zoom());
    value.width = Math.max(value.width, viewportWidth() / zoom());
    Object.assign(grid.style, { width: `${value.width}px`, minHeight: `${value.height}px`, transform: `scale(${zoom()})` });
    Object.assign(space.style, { width: `${value.width * zoom()}px`, height: `${value.height * zoom() + (grid.classList.contains('notes-board--groups') ? 48 : 0)}px` });
    const label = viewport.closest('.notes-page')?.querySelector('#notes-zoom-value');
    if (label) label.textContent = `${Math.round(zoom() * 100)}%`;
  }
  function refresh() {
    if (disposed) return;
    if (gesture && !editable(items().find(item => item.key === gesture.item.key))) { cancel(); return; }
    narrow = compact || viewportWidth() < 640;
    grid.dataset.boardView = narrow ? 'list' : 'canvas';
    grid.classList.add('notes-board');
    grid.classList.toggle('notes-board--compact', narrow);
    grid.classList.toggle('notes-board--projected', filtered);
    viewport.classList.toggle('notes-scroll--canvas', !narrow);
    space.classList.toggle('notes-canvas-space--active', !narrow);
    grid.tabIndex = narrow ? -1 : 0;
    if (narrow) { space.style.width = ''; space.style.height = ''; grid.style.width = ''; grid.style.transform = ''; grid.style.minHeight = ''; }
    const projected = items();
    grid.classList.toggle('notes-board--groups', projected.some(item => item.kind === 'group' && item.member_ids.length > 1));
    for (const item of projected) {
      const card = cardFor(item);
      if (card) {
        if (narrow) for (const name of ['left', 'top', 'width', 'height']) card.style[name] = '';
        else paint(card, item.layout);
      }
    }
    revealTabs(projected); extent(projected.map(item => item.layout)); layerCards(); positionMenus();
  }
  function setZoom(value, point) {
    if (narrow || disposed) return;
    const rect = grid.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
    const center = point || { x: bounds.left + viewport.clientWidth / 2, y: bounds.top + viewport.clientHeight / 2 };
    const previous = zoom(), world = { x: (center.x - rect.left) / previous, y: (center.y - rect.top) / previous };
    viewState.zoom = Math.max(.25, Math.min(2, value)); refresh();
    viewport.scrollLeft += world.x * (zoom() - previous);
    viewport.scrollTop += world.y * (zoom() - previous);
  }
  function release(current) {
    clearTimeout(current.timer); cancelAnimationFrame(frame); frame = 0;
    current.card.classList.remove('note-card--moving', 'note-card--resizing');
    if (current.card.hasPointerCapture?.(current.pointer)) current.card.releasePointerCapture(current.pointer);
  }
  function cancel(preserveTouches = false) {
    interactionGeneration++; waitingForBridge=false;
    groupDragBridge?.leaveTarget(); hoverKey = null; adopted = null;
    const previousNavigation=navigation; navigation=null; excludedPointer=null;
    if (previousNavigation?.kind==='pan' && viewport.hasPointerCapture?.(previousNavigation.pointer)) viewport.releasePointerCapture(previousNavigation.pointer);
    if (!preserveTouches) touches.clear();
    if (!gesture) return;
    const current = gesture; gesture = null;
    suppressClick = current.active;
    release(current); refresh();
  }
  function scrollParent(card) {
    for (let node = card.parentElement; node; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
    }
    return document.scrollingElement;
  }
  function activate() {
    if (!gesture || disposed) return;
    gesture.active = true;
    gesture.card.classList.add('note-card--moving');
    if (gesture.edges) gesture.card.classList.add('note-card--resizing');
    gesture.card.setPointerCapture(gesture.pointer);
    layerCards(gesture.item.key);
    frame = requestAnimationFrame(autoscroll);
  }
  function down(event) {
    const inViewport = viewport.contains(event.target);
    if (event.pointerType === 'touch' && inViewport && !narrow) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size >= 2) {
      cancel(true); suppressClick = true; excludedPointer = null;
      const [a,b] = [...touches.values()];
      navigation = { kind: 'pinch', distance: Math.hypot(a.x-b.x,a.y-b.y), zoom: zoom(), center: { x: (a.x+b.x)/2, y:(a.y+b.y)/2 } };
      event.preventDefault(); return;
    }
    if (adopted) { if (adopted.pointerId !== event.pointerId) cancel(); return; }
    if (gesture) { if (gesture.pointer !== event.pointerId) cancel(); return; }
    suppressClick = false;
    if (event.button !== 0 || narrow || !inViewport) return;
    const selected = event.target.closest('.note-card');
    if (selected) layerCards(itemFor(selected)?.key);
    if (event.target.closest('a,button,input,select,textarea,summary,details,[role="checkbox"],[contenteditable="true"]')) {
      if (grid.contains(event.target)) excludedPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      return;
    }
    // Rounded corners are visually part of a card even when hit-testing reaches its grid.
    const card = event.target.closest('.note-card') || (event.target === grid && [...grid.querySelectorAll('.note-card')].reverse().find(card => {
      const r = card.getBoundingClientRect();
      return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    }));
    if (!card || !grid.contains(card)) {
      navigation = { kind: 'pan', pointer: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture(event.pointerId); return;
    }
    if (filtered) return;
    const item = itemFor(card), note = item?.note;
    if (!editable(item) || pending.has(item.key)) return;
    const rect = card.getBoundingClientRect();
    const edges = { left: event.clientX - rect.left < 12, right: rect.right - event.clientX < 12, top: event.clientY - rect.top < 12, bottom: rect.bottom - event.clientY < 12 };
    if (item.layout?.position_locked && !Object.values(edges).some(Boolean)) {
      excludedPointer = { id: event.pointerId, x: event.clientX, y: event.clientY }; return;
    }
    const start = normalizeNoteLayout(item.layout), scroller = scrollParent(card);
    gesture = { note, item, card, pointer: event.pointerId, start, next: start, x: event.clientX, y: event.clientY,
      lastX: event.clientX, lastY: event.clientY, scroller, scrollY: scroller.scrollTop, scrollX: scroller.scrollLeft, scale: zoom(), pitch: viewportWidth() / NOTE_COLUMNS, active: false,
      viewportWidth:viewportWidth(),viewportHeight:viewport.clientHeight,
      edges: Object.values(edges).some(Boolean) ? edges : null };
    suppressClick = false;
    if (gesture.edges) gesture.timer = setTimeout(activate, 450);
  }
  function update() {
    if (!gesture?.active) return;
    const { start, edges, scroller } = gesture;
    const dx = Math.round((gesture.lastX - gesture.x + scroller.scrollLeft - gesture.scrollX) / (gesture.pitch * gesture.scale));
    const dy = Math.round((gesture.lastY - gesture.y + scroller.scrollTop - gesture.scrollY) / (NOTE_ROW_HEIGHT * gesture.scale));
    const next = { ...start };
    if (!edges) { next.x += dx; next.y += dy; }
    else {
      if (edges.left) { next.x = Math.max(0, start.x + start.width - 12, Math.min(start.x + start.width - 3, start.x + dx)); next.width = start.x + start.width - next.x; }
      if (edges.right) next.width = start.width + dx;
      if (edges.top) { next.y = Math.max(0, start.y + start.height - 100, Math.min(start.y + start.height - 4, start.y + dy)); next.height = start.y + start.height - next.y; }
      if (edges.bottom) next.height = start.height + dy;
      if (gesture.item.layout?.position_locked) {
        next.x = start.x; next.y = start.y;
        if (edges.left) next.width = start.width - dx;
        if (edges.top) next.height = start.height - dy;
      }
    }
    gesture.next = normalizeNoteLayout(next);
    paint(gesture.card, gesture.next);
    extent(items().map(item => item.key === gesture.item.key ? gesture.next : item.layout));
  }
  function move(event) {
    if (touches.has(event.pointerId)) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (navigation?.kind === 'pinch') {
      if (touches.size >= 2) {
        const [a,b] = [...touches.values()], center = { x:(a.x+b.x)/2, y:(a.y+b.y)/2 };
        setZoom(navigation.zoom * Math.hypot(a.x-b.x,a.y-b.y) / Math.max(1,navigation.distance), center);
        viewport.scrollLeft -= center.x-navigation.center.x; viewport.scrollTop -= center.y-navigation.center.y;
        navigation.center = center;
      }
      event.preventDefault(); return;
    }
    if (navigation?.kind === 'pan' && navigation.pointer === event.pointerId) {
      if (Math.hypot(event.clientX-navigation.x,event.clientY-navigation.y) >= 7) suppressClick = true;
      viewport.scrollLeft = navigation.left + navigation.x-event.clientX;
      viewport.scrollTop = navigation.top + navigation.y-event.clientY;
      event.preventDefault(); return;
    }
    if (excludedPointer?.id === event.pointerId && Math.hypot(event.clientX - excludedPointer.x, event.clientY - excludedPointer.y) >= 7) suppressClick = true;
    if (adopted?.pointerId === event.pointerId) { trackTarget(event, adopted); return; }
    if (!gesture || gesture.pointer !== event.pointerId) return;
    gesture.lastX = event.clientX; gesture.lastY = event.clientY;
    if (!gesture.active) {
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 7) return;
      if (gesture.edges) { cancel(); suppressClick = true; return; }
      activate();
    }
    event.preventDefault(); update();
    if (!gesture.edges) trackTarget(event, { item:gesture.item,pointerId:gesture.pointer });
  }
  function clientToWorld(clientX, clientY) {
    const rect = grid.getBoundingClientRect();
    return { x:(clientX-rect.left)/(viewportWidth()/NOTE_COLUMNS*zoom()), y:(clientY-rect.top)/(NOTE_ROW_HEIGHT*zoom()) };
  }
  function targetAt(event, session) {
    if (filtered || narrow) return null;
    const candidates = items().filter(item => item.key !== session.item?.key && editable(item)
      && (item.kind === 'group' || item.layout.position_locked));
    const preview = groupDragBridge?.targetAt?.(event, session);
    const destination = preview && candidates.find(item => item.key === preview.key);
    if (destination) return destination;
    return document.elementsFromPoint(event.clientX,event.clientY).map(node => node.closest('.note-card'))
      .map(card => candidates.find(item => cardFor(item) === card)).find(Boolean) || null;
  }
  function trackTarget(event, session) {
    if (!groupDragBridge) return;
    const target = targetAt(event,session);
    if (target?.key !== hoverKey) { groupDragBridge.leaveTarget(); hoverKey = target?.key || null; }
    if (target) groupDragBridge.hoverTarget(target,{...session,clientX:event.clientX,clientY:event.clientY,world:clientToWorld(event.clientX,event.clientY)});
  }
  function autoscroll() {
    if (!gesture?.active || disposed) return;
    if (!gesture.card.hasPointerCapture(gesture.pointer)) { cancel(); return; }
    const scroller = gesture.scroller;
    const rect = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    const speed = gesture.lastY > bottom - 48 ? Math.min(18, (gesture.lastY - bottom + 48) / 3)
      : gesture.lastY < top + 48 ? -Math.min(18, (top + 48 - gesture.lastY) / 3) : 0;
    if (speed) { scroller.scrollTop += speed; update(); }
    const bounds = scroller.getBoundingClientRect();
    const speedX = gesture.lastX > bounds.right - 48 ? Math.min(18,(gesture.lastX-bounds.right+48)/3)
      : gesture.lastX < bounds.left + 48 ? -Math.min(18,(bounds.left+48-gesture.lastX)/3) : 0;
    if (speedX) { scroller.scrollLeft += speedX; update(); }
    frame = requestAnimationFrame(autoscroll);
  }
  async function up(event) {
    const currentSession=gesture || adopted;
    if (currentSession && (currentSession.viewportWidth!==viewportWidth() || currentSession.viewportHeight!==viewport.clientHeight)) { cancel(); refresh(); return; }
    touches.delete(event.pointerId);
    if (adopted?.pointerId === event.pointerId) {
      const session=adopted; adopted=null;
      await groupDragBridge?.dropTarget(targetAt(event,session),{...session,clientX:event.clientX,clientY:event.clientY,world:clientToWorld(event.clientX,event.clientY)});
      groupDragBridge?.leaveTarget(); hoverKey=null; return;
    }
    if (navigation) {
      if (navigation.kind === 'pan' && viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      if (!touches.size) navigation = null;
      setTimeout(() => { suppressClick = false; }, 0); return;
    }
    if (excludedPointer?.id === event.pointerId) excludedPointer = null;
    if (!gesture || gesture.pointer !== event.pointerId) { setTimeout(() => { suppressClick = false; }, 0); return; }
    const current = gesture; gesture = null;
    release(current);
    layerCards();
    suppressClick = current.active;
    setTimeout(() => { suppressClick = false; }, 0);
    const latest=items().find(item=>item.key===current.item.key);
    if (disposed || !editable(latest) || latest.revision !== current.item.revision) { refresh(); return; }
    if (current.active && !current.edges && groupDragBridge) {
      const session={item:current.item,pointerId:current.pointer,clientX:event.clientX,clientY:event.clientY,world:clientToWorld(event.clientX,event.clientY)};
      const target=targetAt(event,session);
      const generation=interactionGeneration;
      let consumed=false;
      if (target) {
        waitingForBridge=true;
        try { consumed=await groupDragBridge.dropTarget(target,session); }
        finally { waitingForBridge=false; }
      }
      groupDragBridge.leaveTarget(); hoverKey=null;
      if (consumed || disposed || generation!==interactionGeneration || !editable(items().find(item=>item.key===current.item.key))) { if(!disposed)refresh(); return; }
    }
    if (!current.active || JSON.stringify(current.start) === JSON.stringify(current.next)) { refresh(); return; }
    pending.add(current.item.key); current.card.setAttribute('aria-busy', 'true');
    try {
      if (saveBoardCommand) await saveBoardCommand(commandFor(current.item,current.next));
      else if (current.item.kind === 'note') await saveLayout(current.note, current.next);
    }
    finally { pending.delete(current.item.key); current.card.removeAttribute('aria-busy'); if (!disposed) refresh(); }
  }
  async function click(event) {
    if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    const button=event.target.closest('[data-group-page],[data-group-action],[data-board-action="lock"],[data-board-action="top"]');
    if (!button || !grid.contains(button)) return;
    const item=itemFor(button.closest('.note-card'));
    if (!item) return;
    const page=button.dataset.groupPage;
    if (page && item.kind === 'group') {
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
      if (page === 'overview') { onGroupAction('overview',item); return; }
      const index=item.member_ids.indexOf(item.note.id)+(page==='previous'?-1:1);
      if (index < 0 || index >= item.member_ids.length) return;
      if (activePages instanceof Map) activePages.set(item.id,item.member_ids[index]); else activePages[item.id]=item.member_ids[index];
      onViewChange();
      const next=grid.querySelector(`[data-board-key="${item.key}"] [data-group-page="${page}"]:not(:disabled)`)
        || grid.querySelector(`[data-board-key="${item.key}"] [data-group-page="overview"]`);
      next?.focus({preventScroll:true}); return;
    }
    if (button.dataset.groupAction) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (editable(item)) onGroupAction(button.dataset.groupAction,item);
      return;
    }
    if (!saveBoardCommand || !getBoardItems) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!editable(item) || pending.has(item.key)) return;
    const flag=button.dataset.boardAction==='lock'?'position_locked':'always_on_top';
    pending.add(item.key); button.disabled=true;
    try { await saveBoardCommand(commandFor(item,{[flag]:!item.layout[flag]})); }
    finally { pending.delete(item.key); button.disabled=false; if(!disposed)refresh(); }
  }
  function key(event) {
    if (event.key === 'Escape' && (gesture || navigation || adopted || waitingForBridge)) { event.preventDefault(); cancel(); navigation = null; touches.clear(); }
    if (event.key === 'Escape' && viewState.revealed) {
      const id = viewState.revealed; viewState.revealed = null; layerCards();
      revealStrip?.querySelector(`[data-note-reveal="${id}"]`)?.focus({ preventScroll: true });
    }
    if (event.target !== grid || narrow) return;
    const delta = { ArrowLeft:[-80,0], ArrowRight:[80,0], ArrowUp:[0,-80], ArrowDown:[0,80] }[event.key];
    if (delta) { event.preventDefault(); viewport.scrollBy(...delta); }
  }
  function pointerCancel(event) { touches.delete(event.pointerId); navigation = null; cancel(); }
  function lost(event) {
    if (navigation?.kind === 'pan' && navigation.pointer === event.pointerId && event.target === viewport) {
      navigation = null; touches.delete(event.pointerId);
    }
    // Touch starts with implicit capture on the hit descendant. Transferring it
    // to the card loses that descendant's capture without ending our gesture.
    if (gesture?.pointer === event.pointerId && event.target === gesture.card) cancel();
  }
  function positionMenus() {
    if (disposed) return;
    const bounds = viewport.getBoundingClientRect(), canvas = space.getBoundingClientRect();
    const left = Math.max(0, bounds.left, narrow ? 0 : canvas.left) + 4;
    const right = Math.min(innerWidth, bounds.right, narrow ? innerWidth : canvas.right) - 4;
    const top = Math.max(0, bounds.top, narrow ? 0 : canvas.top) + 4;
    const bottom = Math.min(innerHeight, bounds.bottom, narrow ? innerHeight : canvas.bottom) - 4;
    for (const menu of grid.querySelectorAll('.note-card__menu[open] .note-card__menu-items')) {
      menu.style.transform = '';
      menu.style.maxWidth = `${Math.max(0, Math.min(280, (right - left) / zoom()))}px`;
      menu.style.maxHeight = `${Math.max(0, (bottom - top) / zoom())}px`;
      const rect = menu.getBoundingClientRect();
      const x = Math.max(left, Math.min(rect.left, right - rect.width)) - rect.left;
      const y = Math.max(top, Math.min(rect.top, bottom - rect.height)) - rect.top;
      menu.style.transform = `translate(${x / zoom()}px, ${y / zoom()}px)`;
    }
  }
  function menuToggle(event) {
    if (event.target.matches('.note-card__menu')) { layerCards(); positionMenus(); }
  }
  let observedWidth = viewportWidth(), observedHeight=viewport.clientHeight;
  const observer = new ResizeObserver(() => {
    if (viewportWidth() === observedWidth && viewport.clientHeight === observedHeight) return;
    const crossedBreakpoint = (viewportWidth() < 640) !== (observedWidth < 640);
    const wasNarrow = narrow; observedWidth = viewportWidth(); observedHeight=viewport.clientHeight; cancel(); refresh();
    if (wasNarrow !== narrow || crossedBreakpoint) onViewChange();
  });
  observer.observe(viewport);
  window.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', pointerCancel);
  viewport.addEventListener('lostpointercapture', lost);
  grid.addEventListener('toggle', menuToggle, true);
  window.addEventListener('scroll', positionMenus, true);
  window.addEventListener('resize', positionMenus);
  grid.addEventListener('focusin', cardFocus);
  revealStrip?.addEventListener('click', reveal);
  revealStrip?.addEventListener('focusin', revealFocus);
  grid.addEventListener('click', click, true);
  window.addEventListener('keydown', key);
  refresh();
  if (!narrow) { viewport.scrollLeft = viewState.left || 0; viewport.scrollTop = viewState.top || 0; }
  const controller = {
    refresh,
    clientToWorld,
    adoptGroupDrag(session) {
      cancel();
      if (disposed || filtered || narrow || !Number.isInteger(session?.pointerId)) return false;
      adopted={...session,viewportWidth:viewportWidth(),viewportHeight:viewport.clientHeight}; return true;
    },
    cancel,
    zoomBy(amount) { cancel(); setZoom(zoom() + amount); },
    resetView() { cancel(); viewState.zoom = 1; refresh(); viewport.scrollLeft = 0; viewport.scrollTop = 0; },
    busy: () => !!gesture || !!navigation || !!adopted || waitingForBridge || pending.size > 0,
    destroy() {
      if (revealStrip?.contains(document.activeElement)) viewState.revealFocus = Number(document.activeElement.dataset.noteReveal);
      if (!narrow) { viewState.left = viewport.scrollLeft; viewState.top = viewport.scrollTop; }
      cancel(); disposed = true; observer.disconnect();
      window.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', pointerCancel);
      viewport.removeEventListener('lostpointercapture', lost);
      grid.removeEventListener('toggle', menuToggle, true);
      window.removeEventListener('scroll', positionMenus, true);
      window.removeEventListener('resize', positionMenus);
      grid.removeEventListener('focusin', cardFocus);
      revealStrip?.removeEventListener('click', reveal);
      revealStrip?.removeEventListener('focusin', revealFocus);
      if (revealStrip) { revealStrip.replaceChildren(); revealStrip.hidden = true; }
      grid.removeEventListener('click', click, true); window.removeEventListener('keydown', key);
      grid.classList.remove('notes-board', 'notes-board--compact', 'notes-board--projected', 'notes-board--groups');
      viewport.classList.remove('notes-scroll--canvas'); space.classList.remove('notes-canvas-space--active');
      for (const name of ['minHeight','width','transform']) grid.style[name] = '';
      space.style.width = ''; space.style.height = '';
    },
  };
  controller.dispose = controller.destroy;
  return controller;
}
