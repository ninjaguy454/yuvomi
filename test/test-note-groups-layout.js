import test from 'node:test';
import assert from 'node:assert/strict';
import * as layout from '../public/utils/note-board-layout.js';

const rect = { x:80,y:90,width:7,height:9,position_locked:true,always_on_top:true };
const fixture = () => ({ notes: [1,2,3].map(id => ({id,revision:4,title:`Note ${id}`,layout:{x:id,y:2,width:4,height:6,revision:2}})),
  groups:[{id:1,revision:7,layout:{...rect},member_ids:[2,1],can_manage:true}] });

test('a group owns one rectangle independently of the active note and colliding note ID', () => {
  assert.equal(typeof layout.projectNoteGroupItems,'function');
  const board=fixture(),before=structuredClone(board),pages=new Map([[1,1]]);
  const items=layout.projectNoteGroupItems(board,{activePages:pages});
  assert.deepEqual(items.map(i=>i.key),['group:1','note:3']);
  assert.equal(items[0].note.id,1);
  assert.deepEqual(items[0].layout,rect);
  assert.deepEqual(items[0].member_ids,[2,1]);
  assert.equal(layout.projectNoteGroupItems(board)[0].note.id,2,'target page stays first');
  assert.deepEqual(board,before);
});

test('compact and filtered group projections retain every authorized note without changing anchors', () => {
  assert.equal(typeof layout.projectNoteGroupItems,'function');
  const board=fixture(),before=structuredClone(board);
  for(const options of [{compact:true},{filtered:true}]) {
    const items=layout.projectNoteGroupItems(board,options);
    assert.deepEqual(items.flatMap(i=>i.member_ids || [i.note.id]).sort(),[1,2,3]);
    assert.deepEqual(board,before);
    assert.deepEqual(layout.projectNoteGroupItems(board)[0].layout,rect);
  }
  board.notes=board.notes.filter(n=>n.id!==1);
  const group=layout.projectNoteGroupItems(board)[0];
  assert.deepEqual(group.member_ids,[2]);
  assert.equal(group.can_manage,false,'a filtered subset cannot mutate the whole group');
  assert.equal(group.note.id,2);
  assert.deepEqual(group.layout,rect);
  board.notes=board.notes.filter(n=>n.id!==2);
  assert.deepEqual(layout.projectNoteGroupItems(board).map(i=>i.key),['note:3']);
});

test('mixed Organize treats group as one item and preserves locked obstacles, size and flags', () => {
  assert.equal(typeof layout.organizeNoteGroupItems,'function');
  const board=fixture();board.groups[0].layout={...rect,x:0,y:0,width:8};
  const items=layout.projectNoteGroupItems(board),before=structuredClone(items);
  const arranged=layout.organizeNoteGroupItems(items);
  assert.deepEqual(arranged,[{kind:'note',id:3,layout:{x:8,y:0,width:4,height:6,position_locked:false,always_on_top:false}}]);
  const all=layout.organizeNoteGroupItems(items,{includeLocked:true});
  assert.equal(all.length,2);
  assert.deepEqual(all.find(i=>i.kind==='group').layout,{...board.groups[0].layout});
  assert.deepEqual(items,before);
});

test('arrange drafts keep group flags and normalize explicit world placement bounds', () => {
  assert.equal(typeof layout.noteGroupArrangeItem,'function');
  const item={kind:'group',id:1,layout:rect};
  assert.deepEqual(layout.noteGroupArrangeItem(item,{x:-3,y:12000,width:100,height:0}),
    {kind:'group',id:1,layout:{...rect,x:0,y:10000,width:12,height:4}});
});
