import test from 'node:test';
import assert from 'node:assert/strict';

const layout = await import('../public/utils/note-board-layout.js').catch(() => ({}));

test('freeform positions preserve finite fractions while sizes and revisions remain integer', () => {
  const source = { x: 2.375, y: 8.125, width: 4.4, height: 6.3, revision: 7.2 };
  assert.deepEqual(layout.normalizeNoteLayout(source), { x: 2.375, y: 8.125, width: 4, height: 6, revision: 7 });
  assert.deepEqual(source, { x: 2.375, y: 8.125, width: 4.4, height: 6.3, revision: 7.2 });
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(layout.normalizeNoteLayout({ x: invalid, y: invalid }).x, 0);
    assert.equal(layout.normalizeNoteLayout({ x: invalid, y: invalid }).y, 0);
  }
  assert.deepEqual(layout.normalizeNoteLayout({ x: -0.2, y: 10000.25 }), { x: 0, y: 10000, width: 4, height: 6, revision: 0 });
});

test('freeform projection retains existing fractional note and group placements without writes', () => {
  const notes = [{ id: 1, layout: { x: 2.25, y: 3.75, width: 4, height: 6 } }, { id: 2, layout: { x: 9.125, y: 12.5, width: 4, height: 6 } }];
  const before = structuredClone(notes), projected = layout.projectNoteLayouts(notes);
  assert.equal(projected[0].layout.x, 2.25); assert.equal(projected[0].layout.y, 3.75);
  const board = { notes, groups: [{ id: 1, revision: 1, member_ids: [1, 2], can_manage: true, layout: { x: 4.125, y: 6.625, width: 4, height: 6 } }] };
  const grouped = layout.projectNoteGroupItems(board);
  assert.equal(grouped[0].layout.x, 4.125); assert.equal(grouped[0].layout.y, 6.625);
  assert.deepEqual(notes, before);
});

test('organize keeps a fractional pinned obstacle exact and packs movable notes on the grid', () => {
  const notes = [{ id: 1, layout: { x: 0, y: .25, width: 12, height: 6, position_locked: true } }, { id: 2, layout: { x: 2.375, y: 3.125, width: 4, height: 6 } }];
  const before = structuredClone(notes), arranged = layout.organizeNoteLayouts(notes);
  assert.equal(arranged.length, 1); assert.equal(arranged[0].note_id, 2);
  assert.equal(arranged[0].layout.x, 0); assert.equal(arranged[0].layout.y, 7);
  assert.ok(arranged[0].layout.y >= notes[0].layout.y + notes[0].layout.height, 'the packed card clears the fractional obstacle');
  assert.deepEqual(notes, before, 'organizing cannot mutate the fixed obstacle or source snapshot');
});

test('overlap reveal includes every locked card in a dense stack without changing canonical positions', () => {
  const notes=Array.from({length:30},(_,i)=>({id:i+1,layout:{x:80,y:90,width:4,height:6,position_locked:true,always_on_top:i===2}}));
  notes.push({id:31,layout:{x:80,y:90,width:4,height:6,position_locked:false}});
  notes.push({id:32,layout:{x:84,y:90,width:4,height:6,position_locked:true}});
  const before=structuredClone(notes);
  assert.equal(typeof layout.overlappingLockedNoteIds,'function');
  assert.deepEqual(layout.overlappingLockedNoteIds(notes),Array.from({length:30},(_,i)=>i+1));
  assert.deepEqual(layout.overlappingLockedNoteIds(notes,layout.projectNoteLayouts(notes,{filtered:true})),[]);
  assert.deepEqual(notes,before);
  assert.deepEqual(layout.overlappingLockedNoteIds([notes[0]]),[],'only the authorized input collection contributes overlap');
});

test('layout clamps invalid or off-board geometry and keeps controls readable', () => {
  assert.equal(typeof layout.normalizeNoteLayout, 'function', 'board layout helper exists');
  assert.deepEqual(layout.normalizeNoteLayout({x:-20,y:-8,width:300,height:0,revision:2}), {x:0,y:0,width:12,height:4,revision:2});
  const bounded = layout.normalizeNoteLayout({x:11,y:8,width:4,height:6});
  assert.equal(bounded.x,11);
  assert.equal(bounded.width,4);
});

test('wide world positions remain canonical and extents grow only right and down with margin', () => {
  assert.equal(layout.normalizeNoteLayout({x:40,y:80,width:4,height:6}).x,40);
  assert.equal(layout.normalizeNoteLayout({x:20000,y:20000}).x,10000);
  assert.deepEqual(layout.noteCanvasExtent([],1200,700),{width:1200,height:700});
  assert.deepEqual(layout.noteCanvasExtent([{x:40,y:80,width:4,height:6}],1200,700),{width:4592,height:4320});
});

test('organize treats locks and noneditable visible notes as fixed obstacles', () => {
  const notes=[{id:1,layout:{x:0,y:0,width:4,height:6,position_locked:true,revision:2}},
    {id:2,layout:{x:4,y:0,width:4,height:6,revision:1},permissions:{edit:false}},
    {id:3,layout:{x:0,y:0,width:4,height:6,revision:3}}];
  const before=structuredClone(notes);
  const arranged=layout.organizeNoteLayouts(notes,{canEdit:n=>n.permissions?.edit!==false});
  assert.deepEqual(arranged,[{note_id:3,expected_layout_revision:3,layout:{x:8,y:0,width:4,height:6}}]);
  const unlocked=layout.organizeNoteLayouts(notes,{includeLocked:true,canEdit:n=>n.permissions?.edit!==false});
  assert.deepEqual(unlocked.map(item=>item.note_id),[1,3]);
  assert.deepEqual(unlocked[1].layout,{x:8,y:0,width:4,height:6});
  assert.deepEqual(notes,before,'packing cannot alter canonical data or lock flags');
});

test('organize preserves sizes, stable pinned order and creates no overlaps', () => {
  assert.equal(typeof layout.organizeNoteLayouts, 'function');
  const notes = [{id:1,layout:{width:7,height:5}}, {id:2,pinned:1,layout:{width:4,height:8}}, {id:3,layout:{width:3,height:4}}];
  const packed = layout.organizeNoteLayouts(notes);
  assert.equal(packed[0].note_id,2);
  assert.equal(packed.find(n=>n.note_id===1).layout.width,7);
  for(let a=0;a<packed.length;a++)for(let b=a+1;b<packed.length;b++){
    const p=packed[a].layout,q=packed[b].layout;
    assert.ok(p.x+p.width<=q.x || q.x+q.width<=p.x || p.y+p.height<=q.y || q.y+q.height<=p.y);
  }
  assert.deepEqual(notes[0].layout,{width:7,height:5},'projection never mutates source geometry');
});

test('phone and filtered projections retain all notes without saving desktop geometry', () => {
  assert.equal(typeof layout.projectNoteLayouts, 'function');
  const notes=[{id:1,layout:{x:8,y:100,width:4,height:5,revision:7}},{id:2,layout:{x:0,y:4,width:8,height:8}}];
  const original=structuredClone(notes);
  const phone=layout.projectNoteLayouts(notes,{compact:true});
  assert.equal(phone.length,2);
  assert.equal(phone[0].layout.x,0);
  assert.equal(phone[0].layout.y,0);
  assert.equal(phone[1].layout.y,5);
  assert.deepEqual(notes,original);
  const wide=layout.projectNoteLayouts(notes);
  assert.equal(wide[0].layout.y,100);
});
