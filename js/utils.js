/**
 * utils.js — world constants, math helpers and the seeded PRNG.
 *
 * Design rules for this file:
 *  - No DOM, no window, no timers: it is loaded by Node's `vm` in
 *    tools/check-determinism.js as well as by the browser.
 *  - No Math.random() anywhere. Every random value in the simulation comes
 *    from a mulberry32 stream derived from the match seed.
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});

  // ---------------------------------------------------------------- constants
  // Single source of truth for every tunable number in the game.
  // Coordinates are world units with y pointing UP; render.js flips to canvas.
  var CONST = {
    WORLD_W: 1600,            // world width, world units
    WORLD_H: 760,             // nominal world height (shells may arc above it)
    TERRAIN_STEP: 2,          // horizontal spacing between heightfield samples
    GROUND_MIN: 120,          // lowest terrain the generator produces
    GROUND_MAX: 440,          // highest terrain the generator produces
    RIM_MIN: 20,              // minimum outer-rim rise (keeps tanks inside the map)
    RIM_MAX: 70,              // maximum outer-rim rise
    CRATER_FLOOR: 6,          // craters may never dig below this elevation

    TANK_RADIUS: 13,          // broad-phase hit circle radius
    TANK_BODY_OFFSET: 9,      // hull centre above the ground contact point
    TANK_BARREL: 22,          // barrel length (muzzle offset)
    TANK_INTEGRITY: 100,      // starting integrity
    TANK_MIN_ANGLE: 0,
    TANK_MAX_ANGLE: 90,
    TANK_MIN_POWER: 5,
    TANK_MAX_POWER: 100,

    // Movement. A turn's driving is bought in whole action points, spent before the
    // shot is fired, and the whole budget comes back at the start of every turn —
    // points are not banked, so `move` is the entire record of a turn's driving and
    // nothing about it has to be carried forward or hashed.
    MOVE_POINTS: 8,           // action points a tank gets every turn
    MOVE_UNIT: 8,             // world units of x one action point buys
    // 8 points over a crater's 62-unit radius: a tank sitting in a crater can drive
    // out of it in one turn, and a tank on the flat can shift 64 units — 4% of the map
    // and 5% of the 1234-unit spawn separation, so range-finding still has to be done
    // but a bad position is no longer permanent.
    MOVE_GRADE_MAX: 1.0,      // steepest descent the tracks will hold (rise per unit x)
    // Terrain is generated and cratered to a talus limit of 1.45 (terrain.js TALUS),
    // so 1.0 is the line between ground a tank drives down and ground it drops off:
    // a hillside is driven, a crater wall is a fall. Past it the tank leaves the
    // surface and the ordinary falling path takes over, which is the same fall — and
    // the same damage — a crater edge has always produced.

    GRAVITY: 500,             // world units / s^2, pulls shells and falling tanks
    AIR_DRAG: 0.06,           // exponential velocity damping per second
    POWER_SCALE: 9.2,         // muzzle speed (units/s) per point of power
    WIND_ACCEL: 200,          // lateral acceleration at |wind| = 1
    WIND_MIN: -1,             // wind is a signed coefficient in [-1, 1]
    WIND_MAX: 1,
    WIND_BIAS: 1.35,          // exponent on the wind magnitude draw (>1 favours calm)
    WIND_DISPLAY_SCALE: 24,   // HUD shows wind * this, labelled "m/s"

    BLAST_RADIUS: 66,         // damage falloff radius around an impact
    BLAST_DAMAGE: 42,         // damage at the epicentre (before direct-hit bonus)
    BLAST_DIRECT_BONUS: 1.25, // multiplier for a direct hit on a tank
    CRATER_RADIUS: 62,        // radius of terrain removed per shell
    FALL_SAFE_SPEED: 170,     // tanks survive this landing speed unharmed
    FALL_DAMAGE_DIVISOR: 12,  // extra speed above the safe speed -> damage / this

    SIM_STEP: 1 / 120,        // fixed simulation timestep (seconds)
    SIM_SUBSTEPS: 4,          // collision-resolution substeps per sim step
    MAX_STEPS_PER_FRAME: 600, // spiral-of-death guard for the accumulator
    TRAIL_MIN_DIST: 14,       // minimum spacing between recorded trail dots
    TRAIL_MAX_POINTS: 420
  };

  // -------------------------------------------------------------------- math
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function lerp(a, b, t) { return a + (b - a) * t; }

  /** Frame-rate independent easing: fraction of the gap to close this frame. */
  function damp(current, target, rate, dt) {
    return current + (target - current) * (1 - Math.exp(-rate * dt));
  }

  function toRad(deg) { return deg * Math.PI / 180; }
  function toDeg(rad) { return rad * 180 / Math.PI; }

  function dist(ax, ay, bx, by) { return Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)); }

  /** Round to n decimal places (used so printed/HUD values never drift oddly). */
  function round(v, n) {
    var f = Math.pow(10, n == null ? 2 : n);
    return Math.round(v * f) / f;
  }

  /**
   * Shortest distance from point (px, py) to segment (ax, ay)-(bx, by).
   * Used for swept shell-vs-tank collision so a fast shell cannot tunnel.
   */
  function pointSegmentDistance(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    if (len2 === 0) return dist(px, py, ax, ay);
    var t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
    return dist(px, py, ax + dx * t, ay + dy * t);
  }

  // --------------------------------------------------------------------- RNG
  /**
   * mulberry32 — small, fast, deterministic 32-bit PRNG.
   * Returns a function producing floats in [0, 1).
   */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Turn any seed value (number or string such as "EAGLE-4821") into a
   * uint32. Strings use FNV-1a so a human-readable seed is reproducible.
   */
  function hashSeed(value) {
    if (typeof value === 'number' && isFinite(value)) return value >>> 0;
    var str = value == null ? '' : String(value);
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0) || 1;
  }

  /** Wrap a raw mulberry32 stream with a few convenience helpers. */
  function stream(next, seedValue) {
    return {
      seed: seedValue,
      next: next,
      /** Uniform float in [a, b). */
      range: function (a, b) { return a + (b - a) * next(); },
      /** Uniform integer in [a, b] inclusive. */
      int: function (a, b) { return a + Math.floor(next() * (b - a + 1)); },
      pick: function (arr) { return arr[Math.min(arr.length - 1, Math.floor(next() * arr.length))]; },
      sign: function () { return next() < 0.5 ? -1 : 1; }
    };
  }

  /** RNG stream derived from a seed. */
  function fromSeed(seed) {
    var hashed = hashSeed(seed);
    return stream(mulberry32(hashed), seed);
  }

  /**
   * Independent named stream from one match seed, e.g. derive(seed, 'terrain').
   * Different labels never share a sequence, so adding a new subsystem cannot
   * shift the numbers another subsystem already consumed.
   */
  function derive(seed, label) {
    var h = (hashSeed(seed) ^ hashSeed(label)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
    return stream(mulberry32(h), String(seed) + '/' + label);
  }

  /**
   * Roll one turn's wind: a signed coefficient in [WIND_MIN, WIND_MAX].
   * Magnitude is raised to WIND_BIAS so calm turns are common and gales rare.
   * Both game.js and tools/check-determinism.js call this, so there is exactly
   * one definition of the wind sequence.
   */
  function rollWind(rng) {
    var magnitude = Math.pow(rng.next(), CONST.WIND_BIAS);
    var direction = rng.next() < 0.5 ? -1 : 1;
    return round(magnitude * direction, 4);
  }

  TE.CONST = CONST;
  TE.utils = {
    clamp: clamp,
    lerp: lerp,
    damp: damp,
    toRad: toRad,
    toDeg: toDeg,
    dist: dist,
    round: round,
    pointSegmentDistance: pointSegmentDistance
  };
  TE.rng = {
    mulberry32: mulberry32,
    hashSeed: hashSeed,
    fromSeed: fromSeed,
    derive: derive,
    rollWind: rollWind
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
