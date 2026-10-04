import test from 'node:test';
import assert from 'node:assert/strict';

const layout = await import('../public/utils/note-board-layout.js').catch(() => ({}));

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
