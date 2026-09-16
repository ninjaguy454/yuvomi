import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDueAfterCompletion, nextDueAfterExpiration } from '../server/services/recurrence.js';
import { isTerminalRecurrenceOccurrence } from '../server/services/task-recurrence-frontier.js';

test('expired Monday advances to Tuesday on the same daily calendar', () => {
  assert.equal(nextDueAfterExpiration({anchorDate:'2026-09-14',rule:'FREQ=DAILY'}),'2026-09-15');
});

test('restart catch-up retains each expired daily occurrence instead of moving the anchor to restart day', () => {
  let date='2026-09-14';
  const dates=[];
  for(let i=0;i<3;i++) {
    date=nextDueAfterExpiration({anchorDate:date,rule:'FREQ=DAILY'});
    dates.push(date);
  }
  assert.deepEqual(dates,['2026-09-15','2026-09-16','2026-09-17']);
});

test('expiration respects weekly BYDAY and UNTIL instead of inventing a completion-relative date', () => {
  const rule='FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260916';
  const wednesday=nextDueAfterExpiration({anchorDate:'2026-09-14',rule});
  assert.equal(wednesday,'2026-09-16');
  assert.equal(nextDueAfterExpiration({anchorDate:wednesday,rule}),null);
});

test('completion-relative expiration has no successor until an actual reopened completion supplies the anchor', () => {
  const rule='FREQ=DAILY;INTERVAL=3';
  assert.equal(nextDueAfterExpiration({anchorDate:'2026-09-14',rule,fromCompletion:true}),null);
  assert.equal(nextDueAfterCompletion({anchorDate:'2026-09-14',rule,completedOn:'2026-09-16',fromCompletion:true}),'2026-09-19');
});

test('expiration cannot fabricate recurrence without a date or valid rule', () => {
  assert.equal(nextDueAfterExpiration({anchorDate:null,rule:'FREQ=DAILY'}),null);
  assert.equal(nextDueAfterExpiration({anchorDate:'2026-09-14',rule:'INVALID'}),null);
});

test('calendar dates remain consecutive across spring and autumn DST boundaries', () => {
  for(const [before,transition,after] of [
    ['2026-03-07','2026-03-08','2026-03-09'],
    ['2026-10-31','2026-11-01','2026-11-02'],
  ]) {
    assert.equal(nextDueAfterExpiration({anchorDate:before,rule:'FREQ=DAILY'}),transition);
    assert.equal(nextDueAfterExpiration({anchorDate:transition,rule:'FREQ=DAILY'}),after);
  }
});

test('expired is terminal independently of completion and archive state', () => {
  assert.equal(isTerminalRecurrenceOccurrence({status:'expired'}),true);
  assert.equal(isTerminalRecurrenceOccurrence({status:'open',expired_at:'2026-09-14T12:00:00Z'}),true);
  assert.equal(isTerminalRecurrenceOccurrence({status:'in_progress',expired_at:'2026-09-14T12:00:00Z',archived_at:'2026-09-15T00:00:00Z'}),true);
  assert.equal(isTerminalRecurrenceOccurrence({status:'done',expired_at:null}),true);
  assert.equal(isTerminalRecurrenceOccurrence({status:'open',expired_at:null}),false);
  assert.equal(isTerminalRecurrenceOccurrence({status:'open',archived_at:'2026-09-15T00:00:00Z'}),false);
  assert.equal(isTerminalRecurrenceOccurrence(null),false);
});
