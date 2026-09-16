#!/usr/bin/env node
/**
 * tools/check-ui.js — end-to-end UI test in a real browser.
 *
 * Drives index.html through the Chrome DevTools Protocol (no test framework, no
 * npm dependencies — Node 22 has a global WebSocket) and checks the things the
 * pure-simulation suites cannot: that clicking Fire actually launches a shell,
 * that the canvas drag-aim gesture rewrites the aim, that the sliders and seed
 * field are wired up, that the win overlay appears, and that rematch resets the
 * board. It also collects browser-side console errors independently of
 * tools/headless-check.sh.
 *
 * Usage:  node tools/check-ui.js [--shots <dir>] [--chrome <path>]
 * Exit:   0 = all steps passed, 1 = a step failed, 2 = no browser available.
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const PAGE_URL = 'file://' + path.join(ROOT, 'index.html');

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}
const SHOT_DIR = argValue('--shots');
const CHROME = argValue('--chrome') || process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!fs.existsSync(CHROME)) {
  console.error(`SKIP: no Chrome/Chromium at ${CHROME} (pass --chrome <path>)`);
  process.exit(2);
}
if (typeof WebSocket !== 'function') {
  console.error('SKIP: this Node build has no global WebSocket (needs Node 22+)');
  process.exit(2);
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail == null ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n      ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Minimal CDP client over the page target's WebSocket. */
class Client {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20000);
    });
  }

  /** Evaluate an expression in the page and return its value. */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(function(){ ${expression} })()`,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error('page threw: ' + (res.exceptionDetails.exception && res.exceptionDetails.exception.description
        || res.exceptionDetails.text));
    }
    return res.result.value;
  }

  /** Page console errors and uncaught exceptions seen so far. */
  consoleProblems() {
    const problems = [];
    for (const event of this.events) {
      if (event.method === 'Runtime.exceptionThrown') {
        const d = event.params.exceptionDetails;
        problems.push('uncaught: ' + (d.exception && d.exception.description || d.text));
      }
      if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
        problems.push('console.error: ' + (event.params.args || []).map((a) => a.value || a.description).join(' '));
      }
    }
    return problems;
  }

  async screenshot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    return file;
  }
}

async function waitForTarget(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* devtools endpoint not up yet */ }
    await sleep(120);
  }
  throw new Error('Chrome DevTools endpoint never became ready');
}

async function main() {
  const port = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-ui-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1440,900',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    PAGE_URL
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let chromeErr = '';
  chrome.stderr.on('data', (chunk) => { chromeErr += chunk.toString(); });

  let client = null;
  try {
    const target = await waitForTarget(port, Date.now() + 20000);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('WebSocket connection to Chrome failed')));
    });
    client = new Client(ws);
    await client.send('Runtime.enable');
    await client.send('Page.enable');

    // Wait until the game has booted.
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      ready = await client.eval('return !!(window.TanksEvolved && TE.game && TE.game.fire);').catch(() => false);
      if (!ready) await sleep(100);
    }
    if (!ready) throw new Error('window.TanksEvolved never appeared');

    record('page boots and exposes window.TanksEvolved', true,
      await client.eval('return TE.version.label + " · seed " + TanksEvolved.game.world.seed;'));

    // 1. real click on the Fire button launches a shell
    const fired = await client.eval(`
      const before = TanksEvolved.game.world.state;
      document.getElementById('fire-btn').click();
      return { before: before, after: TanksEvolved.game.world.state, hasShell: !!TanksEvolved.game.world.shell };
    `);
    record('clicking Fire launches a shell (aiming -> flying)',
      fired.before === 'aiming' && fired.after === 'flying' && fired.hasShell === true,
      `state ${fired.before} -> ${fired.after}, shell present: ${fired.hasShell}`);

    // 2. the shell lands, carves terrain and returns control to a player
    const landed = await client.eval(`
      // Drive the loop directly rather than relying on rAF scheduling.
      const game = TanksEvolved.game;
      const before = TE.terrain.checksum(game.world.terrain);
      let frames = 0;
      while ((game.world.state === 'flying' || game.world.state === 'settling') && frames < 4000) {
        TanksEvolved.step(1 / 60);
        frames++;
      }
      return {
        state: game.world.state, frames: frames,
        before: before, after: TE.terrain.checksum(game.world.terrain),
        trail: game.world.pastTrails.length,
        turn: game.turn
      };
    `);
    record('the shell lands, carves terrain and passes the turn',
      landed.state === 'aiming' && landed.before !== landed.after && landed.turn === 2,
      `state ${landed.state} after ${landed.frames} frames, terrain ${landed.before} -> ${landed.after}, ` +
      `turn ${landed.turn}, ${landed.trail} trail(s) drawn`);

    // 3. canvas drag rewrites angle and power
    const drag = await client.eval(`
      const canvas = document.getElementById('stage');
      const rect = canvas.getBoundingClientRect();
      const tank = TanksEvolved.game.world.tanks[TanksEvolved.game.world.activeIndex];
      const before = { angle: tank.angle, power: tank.power };
      const x = rect.left + rect.width * 0.5, y = rect.top + rect.height * 0.5;
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x + 140, clientY: y - 90, bubbles: true, cancelable: true, pointerId: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: x + 140, clientY: y - 90, bubbles: true, cancelable: true, pointerId: 1 }));
      return { before: before, after: { angle: tank.angle, power: tank.power } };
    `);
    record('dragging on the battlefield rewrites angle and power',
      drag.after.angle !== drag.before.angle || drag.after.power !== drag.before.power,
      `angle ${drag.before.angle}->${drag.after.angle}, power ${drag.before.power}->${drag.after.power}`);

    // 4. sliders and seed field are wired to the model
    const controls = await client.eval(`
      const tank = TanksEvolved.game.world.tanks[TanksEvolved.game.world.activeIndex];
      const slider = document.getElementById('power-slider');
      slider.value = '37';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      const power = tank.power;
      const readout = document.getElementById('power-readout').textContent;
      const seedField = document.getElementById('seed-input');
      seedField.value = 'unit test seed';
      document.getElementById('seed-set').click();
      return { power: power, readout: readout, seed: TanksEvolved.game.world.seed,
               field: seedField.value, tanks: TanksEvolved.game.world.tanks.length };
    `);
    record('power slider drives the model, seed Set rebuilds the map',
      controls.power === 37 && controls.readout === '37%' &&
      controls.seed === 'UNIT TEST SEED' && controls.field === 'UNIT TEST SEED',
      `power ${controls.power} (readout "${controls.readout}"), seed -> ${controls.seed}`);

    // 5. mute toggle and its label
    const mute = await client.eval(`
      const btn = document.getElementById('mute-btn');
      const before = btn.textContent;
      btn.click();
      const muted = TE.audio.isMuted();
      btn.click();
      return { before: before, afterFirst: muted, afterSecond: TE.audio.isMuted(), label: btn.textContent };
    `);
    record('mute button toggles the audio state',
      mute.before !== mute.label || mute.afterFirst !== mute.afterSecond,
      `label "${mute.before}" -> muted ${mute.afterFirst} -> ${mute.label}, muted again: ${mute.afterSecond}`);

    // 6. force an ending: the win overlay must appear, then Rematch must reset
    const win = await client.eval(`
      const game = TanksEvolved.game;
      game.world.tanks[1].integrity = 0;
      TE.game.finishTurn(game);
      TanksEvolved.step(1 / 60);
      const modal = document.getElementById('modal');
      return {
        state: game.world.state, winner: game.world.winner,
        modalOpen: !modal.hidden, title: document.getElementById('modal-title').textContent,
        sub: document.getElementById('modal-sub').textContent,
        integrity: [game.world.tanks[0].integrity, game.world.tanks[1].integrity]
      };
    `);
    record('reaching 0 integrity ends the match and opens the win overlay',
      win.state === 'over' && win.winner === 1 && win.modalOpen === true && /wins/.test(win.title),
      `${win.title} — ${win.sub}`);
    if (SHOT_DIR) await client.screenshot(path.join(SHOT_DIR, 'win-modal.png'));

    const rematch = await client.eval(`
      document.getElementById('rematch-btn').click();
      const game = TanksEvolved.game;
      return {
        state: game.world.state, turn: game.turn, winner: game.world.winner,
        modalOpen: !document.getElementById('modal').hidden,
        integrity: [game.world.tanks[0].integrity, game.world.tanks[1].integrity],
        seed: game.world.seed
      };
    `);
    record('Rematch clears the overlay and rebuilds the board',
      rematch.state === 'aiming' && rematch.turn === 1 && rematch.modalOpen === false &&
      rematch.integrity[0] === 100 && rematch.integrity[1] === 100,
      `state ${rematch.state}, turn ${rematch.turn}, integrity ${rematch.integrity.join('/')}, seed ${rematch.seed}`);

    // 7. the animation loop really is running (informational: headless rAF can be throttled)
    const loop = await client.eval(`
      return new Promise(function (resolve) {
        const start = TanksEvolved.frames;
        setTimeout(function () {
          resolve({ elapsed: TanksEvolved.frames - start, running: TanksEvolved.running });
        }, 600);
      });
    `);
    record('requestAnimationFrame loop advances frames', loop.running === true,
      `${loop.elapsed} frames in ~600 ms (running: ${loop.running})`);

    // 8. a mid-flight frame for eyeballing, plus a final state summary
    if (SHOT_DIR) {
      await client.eval(`
        const game = TanksEvolved.game;
        game.world.tanks[game.world.activeIndex].angle = 62;
        game.world.tanks[game.world.activeIndex].power = 88;
        TE.game.fire(game);
        for (let i = 0; i < 60; i++) TanksEvolved.step(1 / 60);
        return game.world.state;
      `);
      await client.screenshot(path.join(SHOT_DIR, 'mid-flight.png'));
      await client.eval(`
        const game = TanksEvolved.game;
        for (let i = 0; i < 240 && game.world.state !== 'aiming'; i++) TanksEvolved.step(1 / 60);
        return game.world.state;
      `);
      await client.screenshot(path.join(SHOT_DIR, 'after-impact.png'));
    }

    // 9. no console errors during the whole UI session
    const problems = client.consoleProblems();
    record('no console errors during the UI session', problems.length === 0,
      problems.length ? problems.join(' | ') : '0 console errors, 0 uncaught exceptions');
  } finally {
    try { if (client && client.ws.readyState === 1) client.ws.close(); } catch (e) { /* ignore */ }
    chrome.kill('SIGKILL');
    await sleep(300);
    fs.rmSync(userDataDir, { recursive: true, force: true });
    const noise = chromeErr.split('\n')
      .filter((l) => /Uncaught|SyntaxError|Error:/.test(l))
      .filter((l) => !/cv_display_link|task_policy_set|sqlite|GPU|gpu_/.test(l));
    if (noise.length) console.log('\nchrome stderr (filtered):\n  ' + noise.join('\n  '));
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} UI checks passed`);
  if (SHOT_DIR) console.log(`screenshots written to ${SHOT_DIR}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UI check aborted:', err && err.message);
  process.exit(1);
});
