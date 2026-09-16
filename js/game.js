/**
 * game.js — match/turn state machine, damage, per-turn wind, win + rematch,
 * and the application bootstrap (renderer + input + audio + frame loop).
 *
 * Turn cycle:
 *   aiming ──fire()──▶ flying ──impact──▶ settling ──all tanks grounded──▶
 *      ▲                                                        │
 *      └──────────── next player, wind re-rolled ◀─────────────┘
 *   ...or `over` when a tank reaches 0 integrity.
 *
 * The simulation advances on a fixed timestep (CONST.SIM_STEP) with an
 * accumulator, so the same seed and the same inputs always produce the same
 * match regardless of frame rate. No Math.random anywhere: terrain, spawns,
 * wind and even visual FX come from seeded streams.
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});
  var C = TE.CONST;
  var U = TE.utils;

  var MAX_FLIGHT_TIME = 30;    // simulated seconds before a shell is written off
  var MAX_PAST_TRAILS = 5;     // how many previous shot arcs stay on screen
  var DEFAULT_SEED = 'EAGLE-4821';

  // ------------------------------------------------------------- match setup
  /**
   * Choose a spawn x inside [minFrac, maxFrac] of the map, preferring flat
   * ground so tanks do not start on a cliff edge. Uses the seeded stream, so
   * the same seed always places the tanks identically.
   */
  function pickSpawnX(terrain, rng, minFrac, maxFrac) {
    var best = null;
    for (var i = 0; i < 12; i++) {
      var x = U.lerp(minFrac, maxFrac, rng.next()) * C.WORLD_W;
      var flat = Math.abs(TE.terrain.heightAt(terrain, x + 14) - TE.terrain.heightAt(terrain, x - 14));
      flat += Math.abs(TE.terrain.heightAt(terrain, x + 30) - TE.terrain.heightAt(terrain, x - 30)) * 0.5;
      if (!best || flat < best.flat) best = { x: x, flat: flat };
    }
    return best.x;
  }

  /** Create a match object. Hooks are attached later by boot(). */
  function create(seed) {
    var game = { seed: null, turn: 1, world: null, fixedAcc: 0, hooks: {} };
    reset(game, seed == null ? DEFAULT_SEED : seed);
    return game;
  }

  /** Start a fresh match on the given seed (used by "Rematch" / "New map"). */
  function reset(game, seed) {
    var terrain = TE.terrain.create(seed);
    var spawnRng = TE.rng.derive(seed, 'spawn');

    var tanks = [
      TE.tank.create(1, pickSpawnX(terrain, spawnRng, 0.05, 0.22), terrain),
      TE.tank.create(2, pickSpawnX(terrain, spawnRng, 0.78, 0.95), terrain)
    ];

    game.seed = seed;
    game.turn = 1;
    game.fixedAcc = 0;
    game.world = {
      seed: seed,
      terrain: terrain,
      tanks: tanks,
      wind: 0,
      windRng: TE.rng.derive(seed, 'wind'),
      activeIndex: 0,
      state: 'aiming',
      winner: 0,
      shell: null,
      trail: [],
      pastTrails: [],
      shotCount: 0
    };
    beginTurn(game, true);
    return game;
  }

  /** Roll the wind and hand control to the active player. */
  function beginTurn(game, isFirst) {
    var w = game.world;
    w.wind = TE.rng.rollWind(w.windRng);
    w.shell = null;
    w.trail = [];
    w.state = 'aiming';
    if (game.hooks.onTurn) game.hooks.onTurn(w, game, isFirst === true);
  }

  /** Fire the active tank's shell. Returns false when it is not allowed. */
  function fire(game) {
    var w = game.world;
    if (w.state !== 'aiming' || w.winner) return false;

    var tank = w.tanks[w.activeIndex];
    if (!tank.alive) return false;

    var m = TE.tank.muzzle(tank);
    w.shell = TE.physics.createProjectile(m.x, m.y, tank.angle, tank.power, tank.facing, tank.id, w.wind);
    w.trail = [];
    w.pastTrails.push(w.trail);
    while (w.pastTrails.length > MAX_PAST_TRAILS) w.pastTrails.shift();
    w.shotCount++;
    w.state = 'flying';
    if (game.hooks.onFire) game.hooks.onFire(w, game, tank, m);
    return true;
  }

  /** Append a trail dot when the shell has travelled far enough (deterministic). */
  function recordTrail(w) {
    var s = w.shell;
    if (!s || w.trail.length >= C.TRAIL_MAX_POINTS) return;
    var last = w.trail[w.trail.length - 1];
    if (!last) { w.trail.push({ x: s.x, y: s.y }); return; }
    var dx = s.x - last.x;
    var dy = s.y - last.y;
    if (dx * dx + dy * dy >= C.TRAIL_MIN_DIST * C.TRAIL_MIN_DIST) w.trail.push({ x: s.x, y: s.y });
  }

  // ------------------------------------------------------------------- impact
  /**
   * Apply an impact: carve the crater, damage tanks by distance falloff,
   * notify the presentation layer, then hand over to the settling phase.
   */
  function resolveImpact(game, event) {
    var w = game.world;
    w.state = 'settling';
    w.shell = null;

    if (event.type === 'lost') {
      if (game.hooks.onLost) game.hooks.onLost(w, game, event);
      return;
    }

    // 1. Destroy terrain.
    var dug = TE.terrain.carve(w.terrain, event.x, C.CRATER_RADIUS);

    // 2. Damage everything inside the blast radius, with distance falloff.
    var results = [];
    for (var i = 0; i < w.tanks.length; i++) {
      var tank = w.tanks[i];
      var center = TE.tank.bodyCenter(tank);
      var distance = U.dist(event.x, event.y, center.x, center.y);
      if (distance > C.BLAST_RADIUS) {
        results.push({ tank: tank, distance: distance, damage: 0, direct: false });
        continue;
      }
      var falloff = 1 - distance / C.BLAST_RADIUS;
      var amount = C.BLAST_DAMAGE * Math.pow(falloff, 1.25);
      var direct = event.tank === tank;
      if (direct) amount = Math.max(amount, C.BLAST_DAMAGE * C.BLAST_DIRECT_BONUS);
      var applied = TE.tank.damage(tank, amount);
      results.push({ tank: tank, distance: distance, damage: applied, direct: direct });
    }

    if (game.hooks.onImpact) {
      game.hooks.onImpact(w, game, event, { dug: dug, results: results });
    }
  }

  /** Decide the winner or pass the turn on. */
  function finishTurn(game) {
    var w = game.world;
    var destroyed = [];
    for (var i = 0; i < w.tanks.length; i++) {
      if (w.tanks[i].integrity <= 0) destroyed.push(i);
    }

    if (destroyed.length > 0) {
      w.state = 'over';
      // Both tanks can go up at once (a shared crater): that is a draw.
      w.winner = destroyed.length === 2 ? 0 : w.tanks[1 - destroyed[0]].id;
      if (game.hooks.onGameOver) game.hooks.onGameOver(w, game, w.winner);
      return;
    }

    w.activeIndex = 1 - w.activeIndex;
    game.turn++;
    beginTurn(game, false);
  }

  // -------------------------------------------------------------- simulation
  function simulateStep(game, dt) {
    var w = game.world;

    if (w.state === 'flying' && w.shell) {
      var sub = dt / C.SIM_SUBSTEPS;
      for (var s = 0; s < C.SIM_SUBSTEPS; s++) {
        var event = TE.physics.step(w, w.shell, sub);
        recordTrail(w);
        if (event) { resolveImpact(game, event); break; }
      }
      return;
    }

    if (w.state === 'settling') {
      var falling = false;
      for (var i = 0; i < w.tanks.length; i++) {
        var tank = w.tanks[i];
        var result = TE.tank.update(tank, dt, w.terrain);
        if (result && result.landed && result.damage > 0) {
          var applied = TE.tank.damage(tank, result.damage);
          if (game.hooks.onFall) game.hooks.onFall(w, game, tank, result, applied);
        }
        if (!tank.onGround) falling = true;
      }
      if (!falling) finishTurn(game);
    }
  }

  /**
   * Advance the match by dt seconds of wall-clock time, on a fixed timestep.
   * The accumulator is capped so a backgrounded tab cannot make the shell
   * teleport (or the loop spiral) when the player comes back.
   */
  function update(game, dt) {
    var w = game.world;
    if (w.state === 'over') return;

    game.fixedAcc += Math.min(dt, 0.25);
    var steps = 0;
    while (game.fixedAcc >= C.SIM_STEP && steps < C.MAX_STEPS_PER_FRAME && w.state !== 'over') {
      game.fixedAcc -= C.SIM_STEP;
      simulateStep(game, C.SIM_STEP);
      steps++;
    }
    if (steps >= C.MAX_STEPS_PER_FRAME) game.fixedAcc = 0;

    // Safety net: a shell that never lands (should be unreachable) is retired.
    if (w.state === 'flying' && w.shell && w.shell.age > MAX_FLIGHT_TIME) {
      resolveImpact(game, { type: 'lost', x: w.shell.x, y: w.shell.y, speed: w.shell.speed });
    }
  }

  /**
   * Stable fingerprint of everything that affects the outcome. The self-test
   * compares two runs of the same seed and expects identical hashes.
   */
  function stateHash(game) {
    var w = game.world;
    var parts = [
      String(w.seed), w.state, 'turn' + game.turn, 'active' + w.activeIndex,
      'wind' + w.wind.toFixed(6), 'shots' + w.shotCount,
      'terrain' + TE.terrain.checksum(w.terrain)
    ];
    for (var i = 0; i < w.tanks.length; i++) {
      var t = w.tanks[i];
      parts.push('t' + t.id + ':' + t.x.toFixed(6) + ',' + t.y.toFixed(6) +
        ',' + t.integrity.toFixed(6) + ',' + t.angle.toFixed(3) + ',' + t.power.toFixed(3) +
        ',' + (t.onGround ? 'g' : 'a'));
    }
    if (w.shell) parts.push('shell:' + w.shell.x.toFixed(6) + ',' + w.shell.y.toFixed(6));
    return parts.join('|');
  }

  // ---------------------------------------------------------------- bootstrap
  /**
   * Wire renderer + input + audio and start the frame loop.
   * Returns an app object (also exposed as window.TanksEvolved) with a manual
   * `step(dt)` so tests can drive the loop without requestAnimationFrame.
   *
   * @param {object} [options] { seed, document, autoLoop }
   */
  function boot(options) {
    if (typeof root.document === 'undefined') return null;
    var opts = options || {};
    var doc = opts.document || root.document;
    var canvas = doc && doc.getElementById ? doc.getElementById('stage') : null;
    if (!canvas) return null;

    var renderer = TE.render.create(canvas);
    var game = create(opts.seed || DEFAULT_SEED);
    TE.render.setSeed(renderer, game.world.seed);
    wireHooks(game, renderer);

    var app = {
      game: game,
      renderer: renderer,
      controller: null,
      running: false,
      lastTime: 0,
      rafId: null,
      frames: 0
    };

    app.controller = TE.input.attach({
      game: game,
      renderer: renderer,
      audio: TE.audio,
      document: doc
    });

    /** One presentation frame: simulate, move the camera, draw, sync the HUD. */
    app.step = function (dt) {
      update(game, dt);
      TE.render.updateCamera(renderer, game.world, dt);
      TE.render.updateFx(renderer, game.world, dt);
      TE.render.draw(renderer, game.world);
      app.controller.refresh();
      app.frames++;
      return game.world.state;
    };

    function frame(now) {
      if (!app.running) return;
      var t = (typeof now === 'number' ? now : Date.now()) / 1000;
      var dt = app.lastTime ? Math.min(0.1, t - app.lastTime) : 1 / 60;
      app.lastTime = t;
      app.step(dt);
      app.rafId = root.requestAnimationFrame ? root.requestAnimationFrame(frame)
        : root.setTimeout(function () { frame(); }, 16);
    }

    app.start = function () {
      if (app.running) return app;
      app.running = true;
      app.lastTime = 0;
      app.rafId = root.requestAnimationFrame ? root.requestAnimationFrame(frame)
        : root.setTimeout(function () { frame(); }, 16);
      return app;
    };

    app.stop = function () {
      app.running = false;
      if (app.rafId && root.cancelAnimationFrame) root.cancelAnimationFrame(app.rafId);
      app.rafId = null;
      return app;
    };

    app.restart = function (seed) {
      reset(game, seed == null ? game.world.seed : seed);
      TE.render.setSeed(renderer, game.world.seed);
      TE.render.resize(renderer);
      return app;
    };

    root.TanksEvolved = app;
    if (opts.autoLoop !== false) app.start();
    return app;
  }

  /** Connect simulation events to sound and particle effects. */
  function wireHooks(game, renderer) {
    var R = TE.render;
    var A = TE.audio;

    game.hooks.onTurn = function (world) {
      if (A.setWind) A.setWind(world.wind);
    };

    game.hooks.onFire = function (world, g, tank, muzzle) {
      A.fire();
      R.addMuzzleFlash(renderer, muzzle.x, muzzle.y, tank.angle, tank.facing);
      R.addShake(renderer, 3.5);
    };

    game.hooks.onImpact = function (world, g, event, info) {
      var camera = renderer ? { x: renderer.cam.x, y: renderer.cam.y } : { x: event.x, y: event.y };
      var cameraDistance = U.dist(event.x, event.y, camera.x, camera.y);
      var strength = 0.6 + Math.min(1, event.speed / 900) * 0.6;

      R.addExplosion(renderer, event.x, event.y, C.BLAST_RADIUS, strength);
      R.addScorch(renderer, event.x, event.y, C.CRATER_RADIUS * 0.9);
      R.addShake(renderer, 10 * strength);
      A.explosion(strength, cameraDistance);

      for (var i = 0; i < info.results.length; i++) {
        var r = info.results[i];
        if (r.damage <= 0) continue;
        R.pushFloater(renderer, '-' + Math.round(r.damage), r.tank.x, r.tank.y + 46,
          r.tank.id === 1 ? R.COLORS.p1 : R.COLORS.p2);
        if (r.direct) A.armorHit();
      }
    };

    game.hooks.onFall = function (world, g, tank, result, applied) {
      R.pushFloater(renderer, 'landing -' + Math.round(applied), tank.x, tank.y + 46, '#fbbf24');
      A.explosion(0.35, 200);
      R.addShake(renderer, 4);
    };

    game.hooks.onLost = function (world, g, event) {
      A.whoosh();
      R.pushFloater(renderer, 'OUT OF PLAY', U.clamp(event.x, 60, C.WORLD_W - 60), Math.max(60, event.y), '#94a3b8');
    };

    game.hooks.onGameOver = function (world, g, winner) {
      A.fanfare();
      R.addShake(renderer, 16);
      var tank = world.tanks[winner - 1];
      if (tank) R.pushFloater(renderer, winner ? tank.name + ' WINS' : 'DRAW', tank.x, tank.y + 90, '#ffffff');
    };
  }

  TE.game = {
    create: create,
    reset: reset,
    fire: fire,
    update: update,
    stateHash: stateHash,
    resolveImpact: resolveImpact,
    finishTurn: finishTurn,
    boot: boot,
    DEFAULT_SEED: DEFAULT_SEED
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
