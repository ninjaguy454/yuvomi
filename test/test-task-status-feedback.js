import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskStatusFeedback } from '../public/utils/task-status-feedback.js';

test('an intent paints immediately, blocks overlap, and stale acknowledgements cannot replace it', () => {
  const views=[];
  const feedback=createTaskStatusFeedback(view=>views.push(view));
  const first=feedback.begin(7,'done');
  assert.deepEqual(views.at(-1),{id:7,status:'done',phase:'pending'});
  assert.equal(feedback.begin(7,'open'),null);
  feedback.set(7,first,'uncertain');
  assert.equal(views.at(-1).phase,'uncertain');
  feedback.set(7,first,'confirmed');
  assert.equal(feedback.begin(7,'open'),null,'wait for canonical refresh before another write');
  feedback.clear(7,first);
  const second=feedback.begin(7,'open');
  assert.ok(second);
  feedback.set(7,first,'failed');
  assert.deepEqual(views.at(-1),{id:7,status:'open',phase:'pending'});
  feedback.set(7,second,'failed');
  assert.deepEqual(views.at(-1),{id:7,status:'open',phase:'failed'});
  assert.equal(feedback.resetSettled(7),true);
  assert.deepEqual(views.at(-1),{id:7,status:null,phase:null});
  assert.ok(feedback.begin(7,'done'));
});

test('repaint preserves pending state across list replacement and clear restores canonical controls', () => {
  const views=[];
  const feedback=createTaskStatusFeedback(view=>views.push(view));
  const token=feedback.begin(12,'done');
  feedback.repaint();
  assert.deepEqual(views.at(-1),{id:12,status:'done',phase:'pending'});
  feedback.clear(12,token);
  assert.deepEqual(views.at(-1),{id:12,status:null,phase:null});
});
