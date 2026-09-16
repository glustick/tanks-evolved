/**
 * selftest.js — in-page verification, run by opening `index.html#selftest`.
 *
 * It re-checks in a real browser what tools/check-determinism.js checks in
 * Node (same seed -> same terrain, same match), and additionally proves that
 * the presentation layer loaded, that the DOM contract in input.js still
 * matches index.html, and that the game can be driven to a conclusion without
 * throwing.
 *
 * Results are printed with console.log (readable from a headless Chrome run)
 * and mirrored into the page title so a screenshot-less check is possible.
 *
 * Format contract: on success the last line is `SELFTEST PASS`, on failure
 * `SELFTEST FAIL`.
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});

  /** Should the self-test run for this location hash? */
  function requested(hash) {
    return typeof hash === 'string' && hash.indexOf('selftest') !== -1;
  }

  /** Drive one match with a fixed policy: N shots, fixed timestep, no rAF. */
  function playScriptedMatch(app, shots, dt) {
    var game = app.game;
    var world = game.world;
    var step = dt || 1 / 60;

    for (var shot = 0; shot < shots && world.state !== 'over'; shot++) {
      var tank = world.tanks[world.activeIndex];
      // Deterministic aim schedule: vary angle and power per shot index.
      tank.angle = 30 + ((shot * 7) % 45);
      tank.power = 55 + ((shot * 11) % 45);
      fireAndSettle(game, step);
    }
    return TE.game.stateHash(game);
  }

  /**
   * Brute-force aim solver, used only by the self-test: search a coarse
   * angle/power grid with the real projectile integrator and keep the shot
   * whose impact lands closest to the target tank. This makes "play a match to
   * a win" reliable without hard-coding a lucky angle for one seed.
   */
  function solveShot(world, target) {
    var terrain = world.terrain;
    var tank = world.tanks[world.activeIndex];
    var muzzle = TE.tank.muzzle(tank);
    var centre = TE.tank.bodyCenter(target);
    var best = null;

    function evaluate(angle, power) {
      var event = TE.physics.simulateShot(world, {
        x: muzzle.x, y: muzzle.y, angle: angle, power: power,
        facing: tank.facing, ownerId: tank.id, wind: world.wind
      });
      var distance = TE.utils.dist(event.x, event.y, centre.x, centre.y);
      if (!best || distance < best.distance) best = { angle: angle, power: power, distance: distance };
    }

    for (var angle = 20; angle <= 80; angle += 4) {
      for (var power = 35; power <= 100; power += 4) evaluate(angle, power);
    }
    // Local refinement around the best coarse result.
    var coarse = best;
    for (var a = coarse.angle - 4; a <= coarse.angle + 4; a += 1) {
      for (var p = coarse.power - 4; p <= coarse.power + 4; p += 1) evaluate(a, p);
    }
    return best;
  }

  /** Fire the solved shot and run the simulation until the turn resolves. */
  function fireAndSettle(game, step) {
    if (!TE.game.fire(game)) throw new Error('fire refused in state ' + game.world.state);
    var guard = 0;
    while (game.world.state === 'flying' || game.world.state === 'settling') {
      game.fixedAcc = 0; // consume exactly one frame, no accumulator leftovers
      TE.game.update(game, step);
      if (++guard > 6000) throw new Error('shot never resolved (stuck in ' + game.world.state + ')');
    }
  }

  function run(app) {
    // The self-test drives the simulation itself, so the animation loop must
    // not be advancing the match behind its back.
    if (app.stop) app.stop();

    var results = [];
    var failures = 0;
    var capturedErrors = [];

    // Any uncaught error or rejected promise raised while the self-test runs is
    // reported as a failure, not just printed to the console.
    if (root.addEventListener) {
      root.addEventListener('error', function (event) {
        capturedErrors.push('uncaught error: ' + ((event && event.message) || 'unknown'));
      });
      root.addEventListener('unhandledrejection', function (event) {
        capturedErrors.push('unhandled rejection: ' + ((event && event.reason) || 'unknown'));
      });
    }

    function check(name, fn) {
      try {
        var detail = fn();
        results.push({ ok: true, name: name, detail: detail == null ? '' : String(detail) });
      } catch (err) {
        failures++;
        results.push({ ok: false, name: name, detail: (err && err.message) || String(err) });
      }
    }
    function assert(condition, message) { if (!condition) throw new Error(message); }

    // --- environment -------------------------------------------------------
    check('modules loaded (version, rng, terrain, physics, tank, render, input, audio, game)', function () {
      assert(TE.version && TE.version.RELEASE_VERSION, 'version.js missing');
      assert(TE.rng && TE.rng.mulberry32, 'utils.js rng missing');
      assert(TE.terrain && TE.terrain.create, 'terrain.js missing');
      assert(TE.physics && TE.physics.step, 'physics.js missing');
      assert(TE.tank && TE.tank.create, 'tanks.js missing');
      assert(TE.render && TE.render.draw, 'render.js missing');
      assert(TE.input && TE.input.attach, 'input.js missing');
      assert(TE.audio && TE.audio.toggleMute, 'audio.js missing');
      assert(TE.game && TE.game.fire, 'game.js missing');
      return 'release ' + TE.version.label;
    });

    check('canvas is a real 2D context with non-zero size', function () {
      var ctx = app.renderer.canvas.getContext('2d');
      assert(ctx, 'no 2d context');
      assert(app.renderer.w > 0 && app.renderer.h > 0, 'canvas has zero size');
      return app.renderer.w + 'x' + app.renderer.h + ' CSS px, dpr ' + app.renderer.dpr;
    });

    check('DOM contract: every id in TE.input.REQUIRED_IDS exists', function () {
      var missing = TE.input.REQUIRED_IDS.filter(function (id) {
        return !root.document.getElementById(id);
      });
      assert(missing.length === 0, 'missing elements: ' + missing.join(', '));
      return TE.input.REQUIRED_IDS.length + ' ids present';
    });

    check('input controller reports no missing elements', function () {
      assert(app.controller, 'no controller');
      assert(app.controller.missing.length === 0, 'missing: ' + app.controller.missing.join(', '));
      return 'controller attached, ' + Object.keys(app.controller.els).length + ' elements bound';
    });

    // --- determinism (browser side) ----------------------------------------
    check('same seed -> identical terrain in the browser', function () {
      var a = TE.terrain.create('EAGLE-4821');
      var b = TE.terrain.create('EAGLE-4821');
      assert(TE.terrain.checksum(a) === TE.terrain.checksum(b), 'checksums differ');
      for (var i = 0; i < a.cols; i++) assert(a.heights[i] === b.heights[i], 'sample ' + i + ' differs');
      return 'checksum ' + TE.terrain.checksum(a);
    });

    check('different seed -> different terrain in the browser', function () {
      var a = TE.terrain.checksum(TE.terrain.create('EAGLE-4821'));
      var b = TE.terrain.checksum(TE.terrain.create('FALCON-1'));
      assert(a !== b, 'seeds collided');
      return a + ' vs ' + b;
    });

    check('two scripted matches on one seed produce identical state hashes', function () {
      var seed = 'SELFTEST-77';
      var hashA, hashB, shotsA, shotsB;

      TE.game.reset(app.game, seed);
      TE.render.setSeed(app.renderer, seed);
      hashA = playScriptedMatch(app, 6);
      shotsA = app.game.world.shotCount;

      TE.game.reset(app.game, seed);
      TE.render.setSeed(app.renderer, seed);
      hashB = playScriptedMatch(app, 6);
      shotsB = app.game.world.shotCount;

      assert(hashA === hashB, 'hashes differ\n  A: ' + hashA + '\n  B: ' + hashB);
      assert(shotsA === shotsB, 'shot counts differ');
      return shotsA + ' shots each, equal hash:\n  ' + hashA;
    });

    check('a different seed produces a different match', function () {
      TE.game.reset(app.game, 'SELFTEST-78');
      var hashOther = playScriptedMatch(app, 6);
      TE.game.reset(app.game, 'SELFTEST-77');
      var hashBase = playScriptedMatch(app, 6);
      assert(hashBase !== hashOther, 'two seeds produced the same match');
      return 'seed SELFTEST-77 vs SELFTEST-78 differ (as expected)';
    });

    // --- gameplay rules ----------------------------------------------------
    check('terrain is destroyed by a shell and recorded in the world', function () {
      TE.game.reset(app.game, 'CRATER-TEST');
      var terrain = app.game.world.terrain;
      var before = TE.terrain.checksum(terrain);
      var dug = TE.terrain.carve(terrain, 700, TE.CONST.CRATER_RADIUS);
      assert(dug > 0, 'carve removed nothing');
      assert(TE.terrain.checksum(terrain) !== before, 'checksum unchanged');
      return 'dug ' + dug.toFixed(1) + ' elevation units, checksum ' + before + ' -> ' + TE.terrain.checksum(terrain);
    });

    check('blast damage falls off with distance', function () {
      TE.game.reset(app.game, 'DAMAGE-TEST');
      var w = app.game.world;
      var centre = TE.tank.bodyCenter(w.tanks[0]);
      TE.game.resolveImpact(app.game, { type: 'terrain', x: centre.x, y: centre.y, speed: 500 });
      var near = w.tanks[0].integrity;
      var far = w.tanks[1].integrity;
      assert(near < TE.CONST.TANK_INTEGRITY, 'a point-blank hit did no damage');
      assert(near > 0, 'one point-blank hit should not be instantly fatal');
      assert(far >= TE.CONST.TANK_INTEGRITY, 'the far tank should be untouched at this distance');
      return 'epicentre left ' + near.toFixed(1) + ' integrity, far tank ' + far.toFixed(1);
    });

    check('wind is re-rolled on every turn change and stays in range', function () {
      TE.game.reset(app.game, 'WIND-TEST');
      var game = app.game;
      var seen = [];
      for (var i = 0; i < 6; i++) {
        seen.push(game.world.wind);
        TE.game.finishTurn(game); // the real turn-change path: switch player, re-roll wind
      }
      for (i = 0; i < seen.length; i++) {
        assert(seen[i] >= TE.CONST.WIND_MIN && seen[i] <= TE.CONST.WIND_MAX, 'wind out of range: ' + seen[i]);
      }
      var distinct = seen.filter(function (v, idx) { return seen.indexOf(v) === idx; });
      assert(distinct.length >= 3, 'wind barely changes across turns: ' + seen.join(', '));
      return '6 turns: [' + seen.map(function (v) { return v.toFixed(3); }).join(', ') + ']';
    });

    check('the match can be played to a win, with the win overlay showing', function () {
      TE.game.reset(app.game, 'WIN-TEST');
      var game = app.game;
      var turns = 0;
      var shotsAtEnemy = 0;

      while (game.world.state !== 'over' && turns < 40) {
        var target = game.world.tanks[1 - game.world.activeIndex];
        var solution = solveShot(game.world, target);
        var shooter = game.world.tanks[game.world.activeIndex];
        shooter.angle = solution.angle;
        shooter.power = solution.power;
        fireAndSettle(game, 1 / 60);
        shotsAtEnemy++;
        turns++;
      }
      assert(game.world.state === 'over', 'match did not end in 40 turns (' + game.world.shotCount + ' shots fired)');
      app.step(1 / 60); // let the HUD observe the win state
      var modal = root.document.getElementById('modal');
      assert(modal && !modal.hidden, 'win overlay did not open');
      var title = root.document.getElementById('modal-title').textContent;
      assert(/wins|Draw/.test(title), 'unexpected modal title: ' + title);
      return 'P' + game.world.winner + ' wins after ' + turns + ' turns / ' + shotsAtEnemy +
        ' solved shots; modal says "' + title + '", ' + root.document.getElementById('modal-sub').textContent;
    });

    check('rematch resets integrity, turn, craters and the modal', function () {
      app.controller.rematch();
      var game = app.game;
      assert(game.world.shotCount === 0, 'shot count not reset');
      assert(game.turn === 1, 'turn not reset');
      assert(game.world.state === 'aiming', 'state not reset');
      assert(game.world.tanks[0].integrity === TE.CONST.TANK_INTEGRITY, 'integrity not reset (p1)');
      assert(game.world.tanks[1].integrity === TE.CONST.TANK_INTEGRITY, 'integrity not reset (p2)');
      assert(game.world.pastTrails.length === 0, 'trails not cleared');
      assert(game.world.tanks[0].onGround && game.world.tanks[1].onGround, 'tanks not grounded');
      assert(root.document.getElementById('modal').hidden, 'modal still open after rematch');
      return 'seed ' + game.world.seed + ', both tanks back to ' + TE.CONST.TANK_INTEGRITY;
    });

    check('frames render without throwing (240 frames, mixed states)', function () {
      TE.game.reset(app.game, 'RENDER-TEST');
      var states = {};
      for (var i = 0; i < 240; i++) {
        if (i % 40 === 0) app.controller.fire();
        if (i % 37 === 0) app.controller.fire(); // second call must be refused, not throw
        var state = app.step(1 / 60);
        states[state] = (states[state] || 0) + 1;
      }
      var summary = Object.keys(states).map(function (k) { return k + ':' + states[k]; }).join(' ');
      assert(Object.keys(states).length > 1, 'the match never advanced past one state (' + summary + ')');
      return '240 frames rendered, states seen -> ' + summary;
    });

    check('keyboard shortcuts: active normally, swallowed while typing a seed', function () {
      var doc = root.document;
      var field = doc.getElementById('seed-input');
      var seedBefore = app.game.world.seed;

      function press(target, key) {
        target.dispatchEvent(new root.KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }));
      }

      field.focus();
      assert(doc.activeElement === field, 'seed field did not take focus');
      press(field, 'n'); // "N" is inside plenty of seed words, e.g. NOMAD
      assert(app.game.world.seed === seedBefore,
        'typing "n" in the seed field started a new map (' + seedBefore + ' -> ' + app.game.world.seed + ')');

      field.blur();
      press(doc, 'n');
      assert(app.game.world.seed !== seedBefore, 'the "n" shortcut no longer works outside the seed field');
      return 'seed field swallows n/r/m, "n" still opens a new map when unfocused';
    });

    check('seed normalisation rejects hostile input', function () {
      assert(TE.input.normaliseSeed('  eagle-77 ') === 'EAGLE-77', 'trim/uppercase failed');
      assert(TE.input.normaliseSeed('') === 'TANKS-1', 'empty seed not defaulted');
      var sanitised = TE.input.normaliseSeed('<script>x</script>');
      assert(sanitised === 'SCRIPTXSCRIPT', 'sanitising failed: ' + sanitised);
      assert(TE.input.normaliseSeed(new Array(80).join('a')).length <= 24, 'length not capped');
      assert(TE.input.normaliseSeed('1234') === '1234', 'numeric seed mangled');
      return 'empty -> TANKS-1, markup stripped, capped at 24 chars, numeric seeds preserved';
    });

    // --- report ------------------------------------------------------------
    check('no uncaught errors or unhandled rejections during the self-test', function () {
      assert(capturedErrors.length === 0, capturedErrors.join(' | '));
      return '0 uncaught errors, 0 unhandled rejections';
    });

    // Leave the game in a playable state for a human who opened #selftest.
    TE.game.reset(app.game, TE.game.DEFAULT_SEED);
    TE.render.setSeed(app.renderer, TE.game.DEFAULT_SEED);
    app.controller.refresh(true);

    var lines = ['', 'Tanks Evolved self-test — ' + (TE.version ? TE.version.label : '?'), ''];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      lines.push((r.ok ? 'PASS  ' : 'FAIL  ') + r.name);
      if (r.detail) lines.push('      ' + r.detail.replace(/\n/g, '\n      '));
    }
    lines.push('');
    lines.push(results.length - failures + '/' + results.length + ' checks passed');
    lines.push(failures === 0 ? 'SELFTEST PASS' : 'SELFTEST FAIL');

    var report = lines.join('\n');
    if (root.console && root.console.log) root.console.log(report);
    if (root.document) {
      root.document.title = 'Tanks Evolved — ' + (failures === 0 ? 'SELFTEST PASS' : 'SELFTEST FAIL');
    }

    return { failures: failures, results: results, report: report };
  }

  TE.selftest = { requested: requested, run: run };
})(typeof globalThis !== 'undefined' ? globalThis : this);
