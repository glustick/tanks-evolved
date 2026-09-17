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
  /** How uneven the ground is under x — smaller is flatter. */
  function spawnFlatness(terrain, x) {
    var flat = Math.abs(TE.terrain.heightAt(terrain, x + 14) - TE.terrain.heightAt(terrain, x - 14));
    flat += Math.abs(TE.terrain.heightAt(terrain, x + 30) - TE.terrain.heightAt(terrain, x - 30)) * 0.5;
    return flat;
  }

  /**
   * Choose a spawn x inside [minFrac, maxFrac] of the map, preferring flat
   * ground so tanks do not start on a cliff edge. Uses the seeded stream, so
   * the same seed always places the tanks identically.
   *
   * A candidate that overlaps a barrier is rejected: a tank inside a wall is
   * unshootable, unburiable and unable to hit anything, so it is the one place on
   * the map a spawn must never land. The cover layout keeps out of both spawn
   * bands by construction, so in practice this guard never fires and every
   * existing seed spawns exactly where it used to — it is here for the day the
   * layout moves, and because a spawn inside a wall is not a failure anybody
   * would recognise by looking at it.
   *
   * All twelve candidates are drawn either way, so the spawn stream is read the
   * same number of times whether or not anything is blocked.
   */
  function pickSpawnX(terrain, cover, rng, minFrac, maxFrac) {
    var best = null;
    var bestFree = null;
    var i;
    for (i = 0; i < 12; i++) {
      var x = U.lerp(minFrac, maxFrac, rng.next()) * C.WORLD_W;
      var flat = spawnFlatness(terrain, x);
      if (!best || flat < best.flat) best = { x: x, flat: flat };
      if (!TE.terrain.coverBlocksX(cover, x) && (!bestFree || flat < bestFree.flat)) {
        bestFree = { x: x, flat: flat };
      }
    }
    if (bestFree) return bestFree.x;

    // Every seeded candidate landed in a wall. Sweep the band for the flattest
    // clear spot instead of settling for a spot that happens to be flat: a tank
    // standing inside a barrier is worse than a tank on a slope.
    var lo = minFrac * C.WORLD_W;
    var hi = maxFrac * C.WORLD_W;
    var sweep = null;
    for (var sx = lo; sx <= hi; sx += 4) {
      if (TE.terrain.coverBlocksX(cover, sx)) continue;
      var f = spawnFlatness(terrain, sx);
      if (!sweep || f < sweep.flat) sweep = { x: sx, flat: f };
    }
    return sweep ? sweep.x : best.x;
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
    var cover = TE.terrain.createCover(seed, terrain);
    var spawnRng = TE.rng.derive(seed, 'spawn');

    var tanks = [
      TE.tank.create(1, pickSpawnX(terrain, cover, spawnRng, 0.05, 0.22), terrain),
      TE.tank.create(2, pickSpawnX(terrain, cover, spawnRng, 0.78, 0.95), terrain)
    ];

    game.seed = seed;
    game.turn = 1;
    game.fixedAcc = 0;
    game.world = {
      seed: seed,
      terrain: terrain,
      cover: cover,
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
   *
   * A shell that breaks on a wall is resolved like any other impact — it blows a
   * hole in the ground where it went off, which at a wall is its foot — and the
   * wall is what does not change. That is the split that makes cover static: the
   * terrain is destructible and always was, the block's height never is. Nothing
   * here needs to know which kind of impact it is.
   *
   * The blast is resolved for a wall hit too, so a tank sheltering behind one
   * still takes the falloff damage of the shell that broke on it. That is the
   * whole value of cover: it costs the attacker damage rather than cancelling the
   * shot.
   *
   * Destructible cover — a wall that loses height, and therefore has to enter the
   * replay log the way craters do — is the follow-up this pass deliberately left
   * out.
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
   * Run the simulation until the shot in flight has resolved and control has been handed
   * on — the flight, the impact and the settling, with no wall clock involved.
   *
   * This exists for the one caller that cannot wait: a client rejoining a match in
   * progress has a log of shots to catch up on and no interest in watching them, and it
   * has to arrive at byte-identical state to the player who did watch them. Driving the
   * same fixed step directly, with the accumulator cleared each frame, is exactly what
   * the frame loop would have done — the accumulator only decides *when* steps happen,
   * never what they are.
   *
   * @param {object} game
   * @param {number} [step] seconds per frame; the display loop's usual 1/60
   * @param {number} [maxFrames] guard against a shot that never resolves
   * @returns {number} how many frames it took
   */
  function settle(game, step, maxFrames) {
    var dt = step || 1 / 60;
    var limit = maxFrames || 6000;
    var frames = 0;
    while (game.world.state === 'flying' || game.world.state === 'settling') {
      game.fixedAcc = 0;
      update(game, dt);
      if (++frames >= limit) break;
    }
    return frames;
  }

  /**
   * Stable fingerprint of everything that affects the outcome. The self-test
   * compares two runs of the same seed and expects identical hashes.
   *
   * The cover layout is in here next to the terrain, and for the same reason the
   * terrain is: it is map geometry both clients simulate against. Leaving it out
   * would let two clients agree on a hash while disagreeing about where the walls
   * are — shells would break on one machine and land on the other, and the check
   * that exists to catch exactly that would report agreement.
   */
  function stateHash(game) {
    var w = game.world;
    var parts = [
      String(w.seed), w.state, 'turn' + game.turn, 'active' + w.activeIndex,
      'wind' + w.wind.toFixed(6), 'shots' + w.shotCount,
      'terrain' + TE.terrain.checksum(w.terrain),
      'cover' + TE.terrain.coverChecksum(w.cover)
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
      if (event.type === 'cover') {
        // A wall hit throws sparks off a solid face and rings like armour rather
        // than sounding like earth. The crater it leaves at the foot is the same
        // crater as anywhere else, so the scorch is drawn as usual.
        R.addSparks(renderer, event.x, event.y, event.speed);
        A.armorHit();
      } else {
        A.explosion(strength, cameraDistance);
      }
      R.addShake(renderer, 10 * strength);

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
    settle: settle,
    stateHash: stateHash,
    resolveImpact: resolveImpact,
    finishTurn: finishTurn,
    pickSpawnX: pickSpawnX,
    boot: boot,
    DEFAULT_SEED: DEFAULT_SEED
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
