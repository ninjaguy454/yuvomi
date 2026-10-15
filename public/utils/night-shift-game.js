  const NIGHT_SECONDS = 90;
  const ROOMS = [
    {id: 'stage', name: 'Main stage', code: '01'},
    {id: 'dining', name: 'Dining room', code: '02'},
    {id: 'west', name: 'West hall', code: '03'},
    {id: 'east', name: 'East hall', code: '04'},
    {id: 'store', name: 'Pirate Cove', code: '05'}
  ];
  class Game {
    constructor(seed = 1) { this.seed = seed >>> 0 || 1; this.exit(); }
    random() {
      this.rng = (1664525 * this.rng + 1013904223) >>> 0;
      return this.rng / 4294967296;
    }
    exit() {
      this.rng = this.seed;
      this.state = {phase: 'ready', elapsed: 0, power: 100, camera: 'stage', monitor: true,
        shutters: {left: false, right: false}, reason: null, scareBot: null,
        bots: [
          {id: 'bunny', name: 'Bonnie', behavior: 'quick-patrol', side: 'left', route: ['stage', 'dining', 'west', 'left-door'], room: 'stage', position: 0, moveIn: 8, attackIn: 4, warningSeconds: 4, repelSeconds: 2, held: 0},
          {id: 'chicken', name: 'Chica', behavior: 'lingering-patrol', side: 'right', route: ['stage', 'dining', 'east', 'right-door'], room: 'stage', position: 0, moveIn: 11, attackIn: 5, warningSeconds: 5, repelSeconds: 4, held: 0},
          {id: 'bear', name: 'Freddy', behavior: 'camera-shy', side: 'right', route: ['stage', 'dining', 'east', 'right-door'], room: 'stage', position: 0, moveIn: 16, attackIn: 4, warningSeconds: 4, repelSeconds: 3, held: 0, watched: false},
          {id: 'fox', name: 'Foxy', behavior: 'cove-sprint', side: 'left', route: ['store', 'west', 'left-door'], room: 'store', position: 0, moveIn: 1.5, attackIn: 3, warningSeconds: 3, repelSeconds: 2, held: 0, pressure: 10, running: false}
        ]};
    }
    start() { this.exit(); this.state.phase = 'playing'; }
    pause() { if (this.state.phase === 'playing') this.state.phase = 'paused'; }
    resume() { if (this.state.phase === 'paused') this.state.phase = 'playing'; }
    selectCamera(id) { if (ROOMS.some(room => room.id === id)) this.state.camera = id; }
    setMonitor(on) { if (this.state.phase === 'playing') this.state.monitor = !!on; }
    setShutter(side, closed) {
      if (this.state.phase === 'playing' && ['left', 'right'].includes(side)) this.state.shutters[side] = !!closed;
    }
    lose(reason, bot) { this.state.phase = 'lost'; this.state.reason = reason; this.state.scareBot = bot || 'bear'; }
    step(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return;
      let remaining = Math.min(seconds, 600);
      while (remaining > 0.000001 && this.state.phase === 'playing') {
        const dt = Math.min(.1, remaining, NIGHT_SECONDS - this.state.elapsed);
        remaining -= dt;
        const s = this.state;
        s.elapsed = Math.min(NIGHT_SECONDS, s.elapsed + dt);
        s.power = Math.max(0, s.power - dt * (.28 + (s.monitor ? .16 : 0) + 1.4 * (Number(s.shutters.left) + Number(s.shutters.right))));
        if (s.power < .000001) { s.power = 0; this.lose('power'); break; }
        if (s.elapsed >= NIGHT_SECONDS - .000001) { s.elapsed = NIGHT_SECONDS; s.phase = 'won'; break; }
        for (const bot of s.bots) {
          bot.watched = s.monitor && s.camera === bot.room;
          if (bot.behavior === 'cove-sprint' && !bot.running) {
            bot.pressure = Math.max(0, Math.min(100,bot.pressure + dt * (bot.watched ? -6 : 2)));
            if (bot.pressure >= 100 - .000001) {bot.running=true;bot.position=1;bot.room='west';bot.moveIn=1.5;}
            continue;
          }
          if (bot.position === bot.route.length - 1) {
            if (s.shutters[bot.side]) {
              bot.held += dt;
              if (bot.held >= bot.repelSeconds - .000001) {
                bot.position = 0; bot.room = bot.route[0]; bot.held = 0; bot.attackIn = bot.warningSeconds;
                bot.moveIn = (bot.id === 'bear' ? 14 : 8) + this.random() * 3;
                if(bot.id === 'fox'){bot.running=false;bot.pressure=20;s.power=Math.max(0,s.power-4);if(s.power===0){this.lose('power');break;}}
              }
            } else {
              bot.held = 0; bot.attackIn -= dt;
              if (bot.attackIn <= .000001) { this.lose('intruder', bot.id); break; }
            }
          } else {
            if (bot.behavior === 'camera-shy' && bot.watched) continue;
            bot.moveIn -= dt * (bot.behavior === 'camera-shy' && !s.monitor ? 1.4 : 1);
            if (bot.moveIn <= .000001) {
              bot.position++; bot.room = bot.route[bot.position];
              bot.moveIn = (bot.id==='fox' ? 1.5 : (bot.id==='bear' ? 14 : 8) + this.random() * 3); bot.attackIn = bot.warningSeconds;
            }
          }
        }
      }
    }
  }

export {Game,ROOMS,NIGHT_SECONDS};
