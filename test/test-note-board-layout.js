import test from 'node:test';
import assert from 'node:assert/strict';

const layout = await import('../public/utils/note-board-layout.js').catch(() => ({}));

test('layout clamps invalid or off-board geometry and keeps controls readable', () => {
  assert.equal(typeof layout.normalizeNoteLayout, 'function', 'board layout helper exists');
  assert.deepEqual(layout.normalizeNoteLayout({x:-20,y:-8,width:300,height:0,revision:2}), {x:0,y:0,width:12,height:4,revision:2});
  const bounded = layout.normalizeNoteLayout({x:11,y:8,width:4,height:6});
  assert.equal(bounded.x,8);
  assert.equal(bounded.width,4);
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
