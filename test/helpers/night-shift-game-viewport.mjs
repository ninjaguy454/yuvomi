import assert from 'node:assert/strict';

// Test-only clock steering; production exposes no scenario/debug interface.
export async function installViewportScenario(page) {
  await page.evaluate(async () => {
    const {Game} = await import('/utils/night-shift-game.js');
    const step = Game.prototype.step;
    window.__viewportScenario = {mode: 'playing', model: null};
    Game.prototype.step = function(dt) {
      const scenario = window.__viewportScenario;
      scenario.model = this;
      if (scenario.mode === 'lost') {
        const bot = this.state.bots[0];
        bot.position = bot.route.length - 1;
        bot.room = 'left-door';
        bot.attackIn = .01;
        this.state.shutters.left = false;
      }
      if (scenario.mode === 'won') this.state.elapsed = 89.99;
      step.call(this, dt);
    };
  });
}

export const scenarioMode = (page, mode) => page.evaluate(mode => {
  window.__viewportScenario.mode = mode;
}, mode);

export async function viewportLayout(page, label, safe = {}) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(({label, safe}) => {
    const root = document.querySelector('[data-night-shift-console]');
    const viewport = window.visualViewport;
    const bounds = {
      left: (viewport?.offsetLeft || 0) + (safe.left || 0),
      top: (viewport?.offsetTop || 0) + (safe.top || 0),
      right: (viewport?.offsetLeft || 0) + (viewport?.width || innerWidth) - (safe.right || 0),
      bottom: (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) - (safe.bottom || 0)
    };
    const rect = node => {
      const r = node.getBoundingClientRect();
      return {left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height};
    };
    const visible = node => node.getClientRects().length && node.getBoundingClientRect().width > 1 && node.getBoundingClientRect().height > 1;
    const outside = r => r.left < bounds.left - 1 || r.top < bounds.top - 1 || r.right > bounds.right + 1 || r.bottom > bounds.bottom + 1;
    const controls = [...root.querySelectorAll('button,input[type=range],label.option')].filter(visible).map(node => {
      const r = rect(node), hit = document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
      return {id:node.id || node.textContent.trim(), ...r, disabled:!!node.disabled, outside:outside(r), hit:hit === node || node.contains(hit)};
    });
    const camera = root.querySelector('.scene');
    const containers = [root,...root.querySelectorAll('.sparse-briefing,.hud,.play-grid,.camera-frame,.map-panel,.camera-map,.console-footer,.result,.pause-screen')].filter(visible);
    return {label,phase:root.dataset.phase, bounds, root:rect(root), rootOutside:outside(rect(root)), controls,
      overflow:containers.filter(node => node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2).map(node=>({id:node.id || node.className,client:[node.clientWidth,node.clientHeight],scroll:[node.scrollWidth,node.scrollHeight]})),
      camera:visible(camera)?rect(camera):null, attackVisible:!root.querySelector('#ns-attack-overlay').hidden,
      rootScroll:[root.scrollLeft,root.scrollTop], pageScroll:[scrollX,scrollY]};
  }, {label,safe});
}

// These assertions catch clipping as well as scrolling; hiding overflow alone cannot pass.
export function assertViewportLayout(layout) {
  assert.equal(layout.rootOutside, false, layout.label + ': dialog stays inside usable viewport');
  assert.deepEqual(layout.overflow, [], layout.label + ': no console or section overflow');
  assert.deepEqual(layout.rootScroll, [0,0], layout.label + ': no internal scroll offset');
  for (const control of layout.controls) {
    assert.equal(control.outside, false, layout.label + ': control visible: ' + control.id);
    assert.ok(control.width >= 43.5 && control.height >= 43.5, layout.label + ': 44px target: ' + control.id);
    if (!control.disabled && !layout.attackVisible) assert.equal(control.hit, true, layout.label + ': control is unobscured: ' + control.id);
  }
  if (layout.phase === 'playing') {
    assert.ok(layout.camera?.height >= 32, layout.label + ': camera artwork remains visible');
    assert.equal(layout.controls.filter(control=>control.id.startsWith('ns-')).length >= 5, true);
  }
}
