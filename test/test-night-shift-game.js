import test from 'node:test';
import assert from 'node:assert/strict';
import {Game,ROOMS,NIGHT_SECONDS} from '../public/utils/night-shift-game.js';

test('nothing moves or scares before deliberately starting', () => {
  const game = new Game(17), before = structuredClone(game.state);
  game.step(500);
  assert.deepEqual(game.state, before);
  assert.equal(game.state.phase, 'ready');
});
test('all four franchise characters have distinct roles and routes', () => {
  const game=new Game(17);
  assert.deepEqual(game.state.bots.map(b=>b.name),['Bonnie','Chica','Freddy','Foxy']);
  assert.equal(game.state.bots.find(b=>b.name==='Bonnie').repelSeconds,2);
  assert.equal(game.state.bots.find(b=>b.name==='Chica').repelSeconds,4);
  assert.equal(game.state.bots.find(b=>b.name==='Freddy').behavior,'camera-shy');
  assert.equal(game.state.bots.find(b=>b.name==='Foxy').behavior,'cove-sprint');
});
test('Bonnie and Chica patrol their own hall routes', () => {
  const game = new Game(17); game.start();
  game.step(12);
  assert.equal(game.state.bots[0].room, 'dining');
  assert.equal(game.state.bots[1].room, 'dining');
  game.step(12);
  assert.equal(game.state.bots[0].room, 'west');
  assert.equal(game.state.bots[1].room, 'east');
});
test('an unguarded doorway gives a visible warning before losing', () => {
  const game = new Game(17); game.start();
  while (!game.state.bots.some(bot => bot.room.endsWith('-door'))) game.step(.1);
  const doorway = game.state.bots.find(bot => bot.room.endsWith('-door'));
  assert.equal(game.state.phase, 'playing');
  assert.ok(doorway.attackIn > 3.8);
  game.step(4.2);
  assert.equal(game.state.phase, 'lost');
  assert.equal(game.state.reason, 'intruder');
  assert.ok(game.state.scareBot);
});
test('Bonnie needs two continuous seconds behind the left shutter', () => {
  const game = new Game(17); game.start();
  while (game.state.bots[0].room !== 'left-door') game.step(.1);
  game.setShutter('left', true); game.setShutter('right', true);
  game.step(1.9); assert.equal(game.state.bots[0].room,'left-door');
  game.step(.2);
  assert.equal(game.state.bots[0].room, 'stage');
  assert.equal(game.state.phase, 'playing');
});
test('holding both shutters wastes power and ends the night', () => {
  const game = new Game(17); game.start();
  game.setShutter('left', true); game.setShutter('right', true);
  game.step(40);
  assert.equal(game.state.phase, 'lost');
  assert.equal(game.state.reason, 'power');
  assert.equal(game.state.power, 0);
});
test('reacting to warnings wins a full shift with power remaining', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const game = new Game(seed); game.start();
    while (game.state.phase === 'playing') {
      for (const side of ['left', 'right']) game.setShutter(side, game.state.bots.some(b => b.room === side + '-door'));
      game.step(.1);
    }
    assert.equal(game.state.phase, 'won', 'seed ' + seed);
    assert.equal(game.state.elapsed, NIGHT_SECONDS);
    assert.ok(game.state.power > 5);
  }
});
test('Chica lingers for four seconds behind the right shutter',()=>{
  const game=new Game(17);game.start();
  for(let i=0;i<600&&game.state.bots[1].room!=='right-door';i++){game.setShutter('left',true);game.step(.1);}
  game.setShutter('right',true);game.step(3.9);
  assert.equal(game.state.bots[1].room,'right-door');game.step(.2);
  assert.equal(game.state.bots[1].room,'stage');
});
test('watching Freddy current camera arrests his advance',()=>{
  const watched=new Game(17),unwatched=new Game(17);watched.start();unwatched.start();
  unwatched.selectCamera('dining');
  watched.step(17);unwatched.step(17);
  assert.equal(watched.state.bots[2].room,'stage');
  assert.equal(unwatched.state.bots[2].room,'dining');
  unwatched.selectCamera('dining');const before=unwatched.state.bots[2].moveIn;
  unwatched.step(2);assert.equal(unwatched.state.bots[2].moveIn,before);
});
test('Foxy cove tension rises when neglected and falls when watched',()=>{
  const game=new Game(17);game.start();const foxy=game.state.bots[3];
  game.step(5);assert.ok(foxy.pressure>15);
  game.selectCamera('store');const before=foxy.pressure;game.step(2);assert.ok(foxy.pressure<before);
  game.setMonitor(false);const lowered=foxy.pressure;game.step(2);assert.ok(foxy.pressure>lowered);
});
test('Foxy sprints down west hall after neglect and costs power when repelled',()=>{
  const game=new Game(17);game.start();game.setShutter('left',true);game.setShutter('right',true);
  const foxy=game.state.bots[3];foxy.pressure=99;
  game.step(.6);assert.equal(foxy.room,'west');assert.equal(foxy.running,true);
  game.step(1.6);assert.equal(foxy.room,'left-door');
  const before=game.state.power;game.step(2.1);
  assert.equal(foxy.room,'store');assert.equal(foxy.running,false);assert.ok(game.state.power<before-5);
});
test('each character can cause an attributed intruder loss',()=>{
  for(const id of ['bunny','chicken','bear','fox']){
    const game=new Game(17);game.start();const bot=game.state.bots.find(b=>b.id===id);
    bot.position=bot.route.length-1;bot.room=bot.route.at(-1);bot.attackIn=.1;
    if(id==='fox')bot.running=true;
    game.step(.2);assert.equal(game.state.phase,'lost');assert.equal(game.state.scareBot,id);
  }
});
test('pause freezes threats, power and time until deliberate resume', () => {
  const game = new Game(17); game.start(); game.step(20); game.pause();
  const before = structuredClone(game.state); game.step(999);
  assert.deepEqual(game.state, before);
  game.resume(); game.step(1);
  assert.equal(game.state.phase, 'playing');
  assert.ok(game.state.elapsed > before.elapsed);
});
test('camera selection only accepts rooms and monitor uses power', () => {
  const game = new Game(17); game.start();
  game.selectCamera('not-a-room'); assert.equal(game.state.camera, 'stage');
  for (const room of ROOMS) { game.selectCamera(room.id); assert.equal(game.state.camera, room.id); }
  const monitorOn = new Game(17), monitorOff = new Game(17);
  monitorOn.start(); monitorOff.start(); monitorOff.setMonitor(false);
  monitorOn.step(5); monitorOff.step(5);
  assert.ok(monitorOn.state.power < monitorOff.state.power);
});
test('exit and restart clear all threats, shutters, elapsed time and results', () => {
  const game = new Game(17); game.start(); game.step(60);
  assert.equal(game.state.phase, 'lost');
  const frozen = structuredClone(game.state); game.step(5); assert.deepEqual(game.state, frozen);
  game.exit(); game.step(999); assert.equal(game.state.phase, 'ready');
  game.start(); assert.equal(game.state.elapsed, 0); assert.equal(game.state.power, 100);
  assert.deepEqual(game.state.shutters, {left: false, right: false});
  assert.equal(game.state.reason, null); assert.equal(game.state.scareBot, null);
});


import {createScreamSamples} from '../public/utils/night-shift-scream.js';
test('original scream is a bounded finite waveform with attack and release',()=>{
  const samples=createScreamSamples(22050);
  assert.equal(samples.length,22050);
  let peak=0,energy=0;
  for(const value of samples){assert.ok(Number.isFinite(value));peak=Math.max(peak,Math.abs(value));energy+=value*value;}
  assert.ok(peak>.7&&peak<=.85);assert.ok(Math.sqrt(energy/samples.length)>.08);
  assert.ok(Math.abs(samples[0])<.0001);assert.ok(Math.abs(samples.at(-1))<.0001);
});
test('scream synthesis is deterministic and has no downloaded audio',()=>{
  assert.deepEqual(createScreamSamples(8000),createScreamSamples(8000));
});

import {canEnterNightShift} from '../public/utils/night-shift-copy.js';
test('hidden game eligibility requires the active Night Shift standard Dashboard and existing access',()=>{
  const context={theme:'night-shift',pathname:'/',wallMode:false,editing:false,dashboardAccess:true};
  assert.equal(canEnterNightShift(context),true);
  for(const change of [{theme:'coffee'},{pathname:'/tasks'},{wallMode:true},{editing:true},{dashboardAccess:false}])assert.equal(canEnterNightShift({...context,...change}),false);
});
