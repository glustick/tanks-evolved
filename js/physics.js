/**
 * physics.js — projectile integration (gravity, wind, drag) and collision.
 *
 * The shell is integrated with semi-implicit Euler at a fixed sub-timestep.
 * Given the same muzzle state, wind and terrain, the trajectory is bit-for-bit
 * reproducible: no randomness and no wall-clock input reach this file.
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});
  var C = TE.CONST;
  var U = TE.utils;

  /**
   * Create a shell at the muzzle.
   * Wind is snapshotted here so a shell is not affected by a later turn's wind.
   */
  function createProjectile(x, y, angleDeg, power, facing, ownerId, wind) {
    var rad = U.toRad(angleDeg);
    var speed = power * C.POWER_SCALE;
    return {
      x: x, y: y,
      px: x, py: y,              // previous position (for swept collision)
      vx: Math.cos(rad) * speed * facing,
      vy: Math.sin(rad) * speed,
      ownerId: ownerId,
      wind: wind || 0,
      age: 0,
      speed: speed
    };
  }

  /** Muzzle speed for a given power setting (used by the HUD/aim guide). */
  function muzzleSpeed(power) {
    return power * C.POWER_SCALE;
  }

  /** Refine the exact point where the segment (x0,y0)->(x1,y1) meets the surface. */
  function refineSurfaceCrossing(terrain, x0, y0, x1, y1) {
    var lo = 0;
    var hi = 1;
    for (var i = 0; i < 14; i++) {
      var m = (lo + hi) * 0.5;
      var mx = x0 + (x1 - x0) * m;
      var my = y0 + (y1 - y0) * m;
      if (my > TE.terrain.heightAt(terrain, mx)) lo = m; else hi = m;
    }
    var f = (lo + hi) * 0.5;
    return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f };
  }

  /**
   * Detect what the shell hit between its previous and current position.
   *
   * Resolution order is tank, then cover, then terrain, then off-map — and the
   * order is deliberate at each step. A tank first, because a direct hit has to
   * stay a direct hit whatever it was standing behind. Cover before terrain,
   * because a barrier *stands on* the ground: its base is embedded in the
   * heightfield, so testing the ground first would resolve every shot at a
   * barrier's foot as a terrain hit and the barrier could never be struck at all.
   *
   * @returns {null|{type:string, x:number, y:number, speed:number, tank?:object}}
   *          type is 'tank' | 'cover' | 'terrain' | 'lost'
   */
  function detectImpact(world, p) {
    // 1. Tanks (swept circle test so a fast shell cannot tunnel through).
    var tanks = world.tanks;
    for (var i = 0; i < tanks.length; i++) {
      var tank = tanks[i];
      var c = TE.tank.bodyCenter(tank);
      if (U.pointSegmentDistance(c.x, c.y, p.px, p.py, p.x, p.y) <= C.TANK_RADIUS) {
        return { type: 'tank', x: p.x, y: p.y, speed: Math.hypot(p.vx, p.vy), tank: tank };
      }
    }

    // 2. Solid cover. A swept rectangle test, so the shell stops on the face it
    //    met and the impact point is on that face rather than inside the block.
    if (world.cover && world.cover.length) {
      var block = TE.terrain.coverHit(world.terrain, world.cover, p.px, p.py, p.x, p.y);
      if (block) {
        return {
          type: 'cover', x: block.x, y: block.y,
          speed: Math.hypot(p.vx, p.vy)
        };
      }
    }

    // 3. Terrain.
    var surface = TE.terrain.heightAt(world.terrain, p.x);
    if (p.y <= surface) {
      var hit = refineSurfaceCrossing(world.terrain, p.px, p.py, p.x, p.y);
      return { type: 'terrain', x: hit.x, y: hit.y, speed: Math.hypot(p.vx, p.vy) };
    }

    // 4. Off the map: a miss, no explosion.
    if (p.x < -80 || p.x > C.WORLD_W + 80 || p.y > C.WORLD_H + 420 || p.y < -1400) {
      return { type: 'lost', x: p.x, y: p.y, speed: Math.hypot(p.vx, p.vy) };
    }
    return null;
  }

  /**
   * Advance the shell one sub-step.
   * @returns {null|object} impact event (see detectImpact) or null while flying
   */
  function step(world, p, dt) {
    p.px = p.x;
    p.py = p.y;

    // Wind: constant lateral acceleration for the whole flight (snapshotted).
    p.vx += p.wind * C.WIND_ACCEL * dt;
    // Gravity: y-up world, so it subtracts.
    p.vy -= C.GRAVITY * dt;
    // Air drag: implicit damping, unconditionally stable for any dt.
    var damping = 1 / (1 + C.AIR_DRAG * dt);
    p.vx *= damping;
    p.vy *= damping;

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.age += dt;
    p.speed = Math.hypot(p.vx, p.vy);

    return detectImpact(world, p);
  }

  /**
   * Run a shell to its conclusion without touching world state.
   * Used by tools/check-determinism.js for tuning reports and by the self-test.
   *
   * @param {object} world    a world with `terrain`, `tanks`, `cover` (only read) and `wind`
   * @param {object} shot     { x, y, angle, power, facing, ownerId, wind }
   * @param {object} [opts]   { maxTime, dt }
   * @returns {object} impact event plus `{ time, samples }`
   */
  function simulateShot(world, shot, opts) {
    var o = opts || {};
    var dt = o.dt || (C.SIM_STEP / C.SIM_SUBSTEPS);
    var maxTime = o.maxTime || 26;
    var p = createProjectile(
      shot.x, shot.y, shot.angle, shot.power, shot.facing || 1, shot.ownerId || 1,
      shot.wind == null ? world.wind : shot.wind
    );
    var samples = 0;
    while (p.age < maxTime) {
      var event = step(world, p, dt);
      samples++;
      if (event) {
        event.time = p.age;
        event.samples = samples;
        return event;
      }
    }
    return { type: 'timeout', x: p.x, y: p.y, time: p.age, samples: samples, speed: p.speed };
  }

  TE.physics = {
    createProjectile: createProjectile,
    muzzleSpeed: muzzleSpeed,
    detectImpact: detectImpact,
    step: step,
    simulateShot: simulateShot
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
