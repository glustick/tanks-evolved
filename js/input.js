/**
 * input.js — angle/power controls, firing, turn switching and the DOM HUD.
 *
 * Three input routes drive the same three actions (set angle, set power, fire):
 *   - keyboard shortcuts
 *   - the HUD range sliders / fire button
 *   - pointer drag on the battlefield canvas
 *
 * This file is the only place that knows about element ids, and `REQUIRED_IDS`
 * is exported so the self-test can assert the markup still matches the code.
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});
  var U = TE.utils;
  var C = TE.CONST;

  /** Every element the controller touches. The self-test verifies these exist. */
  var REQUIRED_IDS = [
    'version-tag',
    'turn-value', 'state-value', 'active-value', 'wind-value', 'wind-arrow',
    'seed-input', 'seed-set', 'seed-random',
    'mute-btn',
    'card-p1', 'hp-p1', 'bar-p1', 'aim-p1',
    'card-p2', 'hp-p2', 'bar-p2', 'aim-p2',
    'angle-slider', 'angle-readout', 'power-slider', 'power-readout', 'fire-btn',
    'modal', 'modal-title', 'modal-sub', 'rematch-btn', 'modal-new-seed', 'modal-close'
  ];

  var STATE_LABELS = {
    aiming: 'AIMING',
    flying: 'SHELL IN FLIGHT',
    settling: 'IMPACT',
    over: 'MATCH OVER'
  };

  // UI-only vocabulary for the "Random" seed button. Date-derived on purpose:
  // the simulation itself never touches Math.random or the clock.
  var SEED_WORDS = [
    'EAGLE', 'RAVEN', 'COBRA', 'OUTLAW', 'BISON', 'MIRAGE', 'VULCAN', 'NOMAD',
    'SABRE', 'DRIFTER', 'HYENA', 'KESTREL', 'ONYX', 'ZEPHYR', 'GRANITE', 'PILOT'
  ];

  var DRAG_FULL_POWER_DISTANCE = 330; // world units of drag = 100% power
  var STEP_COARSE = 5;
  var STEP_FINE = 1;

  function pick(doc, id) { return doc && doc.getElementById ? doc.getElementById(id) : null; }

  /** Normalise whatever the player typed into a stable seed string. */
  function normaliseSeed(raw) {
    var s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/[^A-Z0-9\-_ ]/g, '').slice(0, 24);
    return s.length ? s : 'TANKS-1';
  }

  /** UI-layer seed suggestion (see note on SEED_WORDS). */
  function randomSeedLabel() {
    var now = Date.now();
    var word = SEED_WORDS[Math.floor(now / 7) % SEED_WORDS.length];
    var n = (now % 9000) + 1000;
    return word + '-' + n;
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function setClass(node, name, on) {
    if (!node || !node.classList) return;
    if (on) node.classList.add(name); else node.classList.remove(name);
  }

  /**
   * Wire everything up.
   * @param {object} opts { game, renderer, audio, document, onGesture }
   * @returns {object} controller with refresh() and destroy()
   */
  function attach(opts) {
    var doc = opts.document || root.document;
    var game = opts.game;
    var renderer = opts.renderer;
    var audio = opts.audio || TE.audio;

    var els = {};
    var missing = [];
    for (var i = 0; i < REQUIRED_IDS.length; i++) {
      els[REQUIRED_IDS[i]] = pick(doc, REQUIRED_IDS[i]);
      if (!els[REQUIRED_IDS[i]]) missing.push(REQUIRED_IDS[i]);
    }

    // Cache of the last values written to the DOM, so refresh() only touches
    // the DOM when something actually changed.
    var cache = {};
    var drag = null;
    var listeners = [];

    function on(target, type, handler, options) {
      if (!target || !target.addEventListener) return;
      target.addEventListener(type, handler, options);
      listeners.push({ target: target, type: type, handler: handler });
    }

    // ------------------------------------------------------------- gestures
    /**
     * Unlock WebAudio. Called from real event handlers only: browsers refuse to
     * start an AudioContext outside a user gesture, and log a warning if you
     * try. Programmatically dispatched events (`isTrusted === false`, e.g. from
     * automation or the self-test) are ignored for the same reason.
     */
    function unlockAudio(event) {
      if (event && event.isTrusted === false) return;
      if (audio && audio.init) audio.init(true);
      if (audio && audio.startAmbient) audio.startAmbient(true);
    }

    /**
     * Programmatic "the player did something" hook. Deliberately does not
     * create the audio context, so automation and the self-test stay silent.
     */
    function gesture() {
      if (audio && audio.init) audio.init(false);
      if (opts.onGesture) opts.onGesture();
    }

    function activeTank() {
      return game.world.tanks[game.world.activeIndex];
    }

    function applyAngle(value, announce) {
      var tank = activeTank();
      TE.tank.setAngle(tank, value);
      if (announce && audio && audio.click) audio.click();
      refresh(true);
    }

    function applyPower(value) {
      TE.tank.setPower(activeTank(), value);
      refresh(true);
    }

    function fire() {
      gesture();
      if (TE.game.fire(game)) refresh(true);
    }

    // --------------------------------------------------------- keyboard map
    function stepSize(ev) {
      return ev.shiftKey ? STEP_FINE : STEP_COARSE;
    }

    function onKeyDown(ev) {
      unlockAudio(ev); // real keypress: safe to start the audio context

      var key = ev.key;
      var handled = true;
      var tank = activeTank();
      var step = stepSize(ev);

      // Never swallow browser shortcuts (Cmd/Ctrl/Alt + key), and let the seed
      // field own its keys while it has focus — otherwise typing "NOMAD" would
      // trigger the new-map shortcut on every keystroke.
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      var focused = doc && doc.activeElement;
      if (focused && focused.id === 'seed-input') return;

      switch (key) {
        case 'ArrowLeft': case 'a': case 'A':
          applyPower(tank.power - step);
          break;
        case 'ArrowRight': case 'd': case 'D':
          applyPower(tank.power + step);
          break;
        case 'ArrowUp': case 'w': case 'W':
          applyAngle(tank.angle + step, false);
          break;
        case 'ArrowDown': case 's': case 'S':
          applyAngle(tank.angle - step, false);
          break;
        case ' ': case 'Spacebar':
        case 'Enter':
          // Enter belongs to the win overlay when it is open.
          if (key === 'Enter' && isModalOpen()) closeModal(); else fire();
          break;
        case 'm': case 'M': toggleMute(); break;
        case 'r': case 'R': rematch(); break;
        case 'n': case 'N': newMap(); break;
        case 'Escape':
          if (isModalOpen()) closeModal(); else handled = false;
          break;
        default:
          handled = false;
      }
      if (handled && ev.preventDefault) ev.preventDefault();
    }

    // ------------------------------------------------------------ mouse aim
    function canvasPoint(ev) {
      var rect = renderer.canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    function onPointerDown(ev) {
      unlockAudio(ev);
      if (game.world.state !== 'aiming') return;
      if (isModalOpen()) return;
      drag = canvasPoint(ev);
      if (ev.preventDefault) ev.preventDefault();
      if (renderer.canvas.setPointerCapture && ev.pointerId != null) {
        try { renderer.canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      }
      dragAim(drag);
    }

    /** Translate a pointer position into an angle/power pair on the active tank. */
    function dragAim(point) {
      var tank = activeTank();
      var world = TE.render.screenToWorld(renderer, point.x, point.y);
      var pivot = TE.tank.pivotPoint(tank);
      var dx = Math.abs(world.x - pivot.x);
      var dy = world.y - pivot.y;
      var angle = U.toDeg(Math.atan2(dy, dx));
      TE.tank.setAngle(tank, angle);
      var distance = Math.sqrt(dx * dx + dy * dy);
      TE.tank.setPower(tank, (distance / DRAG_FULL_POWER_DISTANCE) * C.TANK_MAX_POWER);
      refresh(true);
    }

    function onPointerMove(ev) {
      if (!drag) return;
      drag = canvasPoint(ev);
      dragAim(drag);
      if (ev.preventDefault) ev.preventDefault();
    }

    function onPointerUp(ev) {
      if (!drag) return;
      drag = null;
      if (ev && ev.preventDefault) ev.preventDefault();
    }

    // ------------------------------------------------------------------ HUD
    function toggleMute() {
      gesture();
      var muted = audio.toggleMute();
      setText(els['mute-btn'], muted ? 'Sound off' : 'Sound on');
      if (els['mute-btn'] && els['mute-btn'].setAttribute) {
        els['mute-btn'].setAttribute('aria-pressed', muted ? 'true' : 'false');
      }
      setClass(els['mute-btn'], 'is-off', muted);
      return muted;
    }

    function applySeed(raw, announce) {
      var seed = normaliseSeed(raw);
      if (els['seed-input']) els['seed-input'].value = seed;
      gesture();
      TE.game.reset(game, seed);
      // The backdrop silhouettes are seed-derived too, so refresh them.
      if (renderer) TE.render.setSeed(renderer, seed);
      if (announce !== false && audio && audio.click) audio.click();
      refresh(true);
      return seed;
    }

    function newMap() {
      applySeed(randomSeedLabel(), true);
    }

    function rematch() {
      applySeed(game.world.seed, true);
      closeModal();
    }

    function isModalOpen() {
      return !!(els.modal && !els.modal.hidden && els.modal.style && els.modal.style.display !== 'none');
    }

    function openModal() {
      if (!els.modal || !els.modal.hidden) return;
      els.modal.hidden = false;
      setClass(els.modal, 'is-open', true);
    }

    function closeModal() {
      if (!els.modal || els.modal.hidden) return;
      els.modal.hidden = true;
      setClass(els.modal, 'is-open', false);
      gesture();
      if (audio && audio.click) audio.click();
    }

    // ------------------------------------------------------------- binding
    function bind() {
      on(doc, 'keydown', onKeyDown);
      on(root, 'blur', function () { drag = null; });
      on(root, 'resize', function () { TE.render.resize(renderer); });

      // A click or keypress anywhere unlocks audio before the first sound plays.
      on(root, 'pointerdown', unlockAudio);
      on(root, 'keydown', unlockAudio);
      if (root.PointerEvent === undefined) on(root, 'touchstart', unlockAudio);

      on(renderer.canvas, 'pointerdown', onPointerDown);
      on(renderer.canvas, 'pointermove', onPointerMove);
      on(renderer.canvas, 'pointerup', onPointerUp);
      on(renderer.canvas, 'pointercancel', onPointerUp);
      on(renderer.canvas, 'pointerleave', onPointerUp);

      on(els['fire-btn'], 'click', fire);
      on(els['mute-btn'], 'click', toggleMute);
      on(els['angle-slider'], 'input', function (ev) { gesture(); applyAngle(parseFloat(ev.target.value), false); });
      on(els['power-slider'], 'input', function (ev) { gesture(); applyPower(parseFloat(ev.target.value)); });
      on(els['seed-set'], 'click', function () { applySeed(els['seed-input'] ? els['seed-input'].value : game.world.seed); });
      on(els['seed-random'], 'click', newMap);
      on(els['seed-input'], 'keydown', function (ev) {
        if (ev.key === 'Enter') { applySeed(ev.target.value); ev.stopPropagation(); }
      });
      on(els['rematch-btn'], 'click', rematch);
      on(els['modal-new-seed'], 'click', function () { newMap(); closeModal(); });
      on(els['modal-close'], 'click', closeModal);
    }

    // ------------------------------------------------------------- h-u-d-out
    function refresh(force) {
      var world = game.world;
      var active = world.tanks[world.activeIndex];

      // Header chips.
      setText(els['turn-value'], String(game.turn));
      setText(els['state-value'], STATE_LABELS[world.state] || world.state);
      setText(els['active-value'], world.state === 'over'
        ? (world.winner === 1 || world.winner === 2 ? 'P' + world.winner + ' WINS' : 'DRAW')
        : active.name.toUpperCase());

      var windShown = U.round(world.wind * C.WIND_DISPLAY_SCALE, 1);
      setText(els['wind-value'], (windShown > 0 ? '+' : '') + windShown.toFixed(1));
      setText(els['wind-arrow'], world.wind > 0.02 ? '\u2192' : (world.wind < -0.02 ? '\u2190' : '\u00b7'));
      setClass(els['wind-value'], 'is-strong', Math.abs(world.wind) > 0.6);

      // Per-tank cards.
      for (var i = 0; i < world.tanks.length; i++) {
        var tank = world.tanks[i];
        var n = i + 1;
        var ratio = TE.tank.integrityRatio(tank);
        var hpKey = 'hp-' + n;
        var barKey = 'bar-' + n;
        var aimKey = 'aim-' + n;
        setText(els[hpKey], tank.alive ? String(Math.round(tank.integrity)) : 'DESTROYED');
        if (els[barKey] && cache[barKey] !== ratio) {
          els[barKey].style.width = (ratio * 100).toFixed(1) + '%';
          setClass(els[barKey], 'is-low', ratio <= 0.3);
          setClass(els[barKey], 'is-mid', ratio > 0.3 && ratio <= 0.6);
          cache[barKey] = ratio;
        }
        setText(els[aimKey], tank.angle.toFixed(0) + '\u00b0 \u00b7 ' + tank.power.toFixed(0) + '%');
        setClass(els['card-' + n], 'is-active', i === world.activeIndex && world.state !== 'over');
        setClass(els['card-' + n], 'is-dead', !tank.alive);
      }

      // Aim controls follow the active tank, but never fight a slider the
      // player is currently dragging.
      if (cache.angle !== active.angle || force) {
        if (els['angle-slider']) els['angle-slider'].value = String(active.angle);
        setText(els['angle-readout'], active.angle.toFixed(0) + '\u00b0');
        cache.angle = active.angle;
      }
      if (cache.power !== active.power || force) {
        if (els['power-slider']) els['power-slider'].value = String(active.power);
        setText(els['power-readout'], active.power.toFixed(0) + '%');
        cache.power = active.power;
      }

      // Fire button availability + active player's accent colour.
      var canFire = world.state === 'aiming' && !world.winner;
      if (cache.canFire !== canFire || force) {
        if (els['fire-btn']) {
          els['fire-btn'].disabled = !canFire;
          setClass(els['fire-btn'], 'is-ready', canFire);
        }
        cache.canFire = canFire;
      }
      if (cache.firePlayer !== active.id) {
        setClass(els['fire-btn'], 'is-p2', active.id === 2);
        cache.firePlayer = active.id;
      }

      // Win overlay.
      if (world.state === 'over' && !cache.modalShown) {
        cache.modalShown = true;
        var winner = world.tanks[world.winner - 1];
        setText(els['modal-title'], winner ? winner.name + ' wins' : 'Draw');
        setText(els['modal-sub'],
          'Seed ' + world.seed + ' \u00b7 ' + world.shotCount + ' shot' + (world.shotCount === 1 ? '' : 's') +
          ' \u00b7 turn ' + game.turn);
        openModal();
      } else if (world.state !== 'over' && cache.modalShown) {
        cache.modalShown = false;
        closeModal();
      }
    }

    /** Initial DOM pass: version tag + first refresh. */
    function boot() {
      var v = TE.version || {};
      setText(els['version-tag'], 'v' + (v.RELEASE_VERSION || '?') + '+b' + (v.BUILD_NUMBER || 0));
      if (els['seed-input']) els['seed-input'].value = String(game.world.seed);
      setText(els['mute-btn'], (audio && audio.isMuted && audio.isMuted()) ? 'Sound off' : 'Sound on');
      bind();
      refresh(true);
    }

    function destroy() {
      for (var i = 0; i < listeners.length; i++) {
        var l = listeners[i];
        if (l.target.removeEventListener) l.target.removeEventListener(l.type, l.handler);
      }
      listeners = [];
    }

    var controller = {
      els: els,
      missing: missing,
      refresh: refresh,
      boot: boot,
      destroy: destroy,
      applyAngle: applyAngle,
      applyPower: applyPower,
      applySeed: applySeed,
      randomSeedLabel: randomSeedLabel,
      normaliseSeed: normaliseSeed,
      fire: fire,
      rematch: rematch,
      newMap: newMap,
      toggleMute: toggleMute,
      isModalOpen: isModalOpen,
      closeModal: closeModal
    };

    controller.boot();
    return controller;
  }

  TE.input = {
    REQUIRED_IDS: REQUIRED_IDS,
    STATE_LABELS: STATE_LABELS,
    attach: attach,
    normaliseSeed: normaliseSeed,
    randomSeedLabel: randomSeedLabel
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
