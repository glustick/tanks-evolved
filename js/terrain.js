/**
 * terrain.js — seeded heightfield generation and crater destruction.
 *
 * The battlefield is a 1-D heightfield (one elevation sample every
 * CONST.TERRAIN_STEP world units). A heightfield cannot represent overhangs,
 * which makes it the classic Artillery-Duel shape: shells carve round bites
 * out of the ground, tanks may end up on a pillar or in a hole, and collision
 * tests stay trivial and exactly deterministic.
 *
 * Everything here is a pure function of its arguments — no Math.random,
 * no DOM — so tools/check-determinism.js can run it under Node's `vm`.
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});
  var C = TE.CONST;
  var U = TE.utils;

  var ROUGHNESS = 0.56;       // amplitude decay per midpoint-displacement octave
  var TALUS = 1.45;           // max height change per world unit of x (slope limit)
  var SMOOTH_PASSES = 2;      // pre-game smoothing passes over the generated field
  var TALUS_PASSES = 4;       // relaxation passes after each crater
  var CRATER_DEPTH_RATIO = 0.55; // pit depth as a fraction of crater radius

  /**
   * Recursive midpoint displacement ("fractal Brownian motion, 1-D").
   * Produces rolling hills from a handful of random draws.
   */
  function displace(heights, lo, hi, amplitude, rng) {
    if (hi - lo < 2) return;
    var mid = (lo + hi) >> 1;
    heights[mid] = (heights[lo] + heights[hi]) * 0.5 + rng.range(-amplitude, amplitude);
    var nextAmplitude = amplitude * ROUGHNESS;
    displace(heights, lo, mid, nextAmplitude, rng);
    displace(heights, mid, hi, nextAmplitude, rng);
  }

  /** In-place 1-2-1 box smoothing; endpoints are pinned. */
  function smooth(heights, passes) {
    var n = heights.length;
    var tmp = new Float64Array(n);
    for (var p = 0; p < passes; p++) {
      for (var i = 0; i < n; i++) tmp[i] = heights[i];
      for (i = 1; i < n - 1; i++) {
        heights[i] = tmp[i - 1] * 0.25 + tmp[i] * 0.5 + tmp[i + 1] * 0.25;
      }
    }
    return heights;
  }

  /**
   * Relax steep steps inside [lo, hi] so crater walls are climbable-looking
   * rather than vertical cliffs. Mass-preserving: each relaxation moves the
   * two neighbouring samples toward each other.
   */
  function limitSlope(heights, lo, hi, maxDelta) {
    lo = Math.max(1, lo);
    hi = Math.min(heights.length - 1, hi);
    for (var pass = 0; pass < TALUS_PASSES; pass++) {
      var changed = false;
      for (var i = lo; i <= hi; i++) {
        var d = heights[i] - heights[i - 1];
        if (d > maxDelta) {
          var e = (d - maxDelta) * 0.5;
          heights[i] -= e; heights[i - 1] += e; changed = true;
        } else if (d < -maxDelta) {
          var e2 = (-d - maxDelta) * 0.5;
          heights[i] += e2; heights[i - 1] -= e2; changed = true;
        }
      }
      if (!changed) break;
    }
  }

  /**
   * Build a terrain for a seed.
   * @param {number|string} seed
   * @returns {{seed:*, step:number, cols:number, width:number, heights:Float64Array}}
   */
  function create(seed) {
    var rng = TE.rng.derive(seed, 'terrain');
    var cols = Math.round(C.WORLD_W / C.TERRAIN_STEP) + 1;
    var heights = new Float64Array(cols);

    // 1. Rolling hills. Keep clear of the limits so the rim rise still fits.
    var top = C.GROUND_MAX - C.RIM_MAX;
    heights[0] = rng.range(C.GROUND_MIN + 40, top);
    heights[cols - 1] = rng.range(C.GROUND_MIN + 40, top);
    displace(heights, 0, cols - 1, rng.range(70, 130), rng);

    // 2. Raise the outer rims: a shallow bowl keeps tanks away from the edges
    //    and gives the map a readable silhouette.
    var rim = rng.range(C.RIM_MIN, C.RIM_MAX);
    for (var i = 0; i < cols; i++) {
      var u = (i / (cols - 1)) * 2 - 1; // -1 at left edge, +1 at right edge
      heights[i] += rim * u * u;
    }

    smooth(heights, SMOOTH_PASSES);
    for (i = 0; i < cols; i++) heights[i] = U.clamp(heights[i], C.GROUND_MIN, C.GROUND_MAX);

    return {
      seed: seed,
      step: C.TERRAIN_STEP,
      cols: cols,
      width: (cols - 1) * C.TERRAIN_STEP,
      heights: heights
    };
  }

  /** Linearly interpolated surface elevation at world x. */
  function heightAt(terrain, x) {
    var h = terrain.heights;
    if (x <= 0) return h[0];
    if (x >= terrain.width) return h[terrain.cols - 1];
    var fi = x / terrain.step;
    var i = fi | 0;
    var t = fi - i;
    var a = h[i];
    var b = i + 1 < terrain.cols ? h[i + 1] : a;
    return a + (b - a) * t;
  }

  /** Surface slope (dy/dx) at world x, sampled over a short baseline. */
  function slopeAt(terrain, x, baseline) {
    var b = baseline || 10;
    return (heightAt(terrain, x + b) - heightAt(terrain, x - b)) / (2 * b);
  }

  /**
   * Dig a crater centred on world x = cx.
   *
   * The pit profile is D * (1 - u^2)^1.5 with u = dx / radius, which — unlike a
   * plain circular profile — has zero slope at the rim, so a crater always
   * blends into the surrounding ground instead of leaving a vertical wall.
   * Peak depth D is CRATER_DEPTH_RATIO * radius, chosen so the steepest point
   * of the pit stays inside the talus limit.
   *
   * Removal is measured from the *local* surface of each column, which keeps
   * the cut bounded no matter where the shell went off: exploding at the foot
   * of a cliff nibbles the cliff by at most D instead of trenching the whole
   * hillside, and a shell landing in an earlier crater simply deepens it.
   * Material is only ever removed, never raised or floated, so the heightfield
   * stays valid for any sequence of hits.
   *
   * @param {object} terrain
   * @param {number} cx     impact x
   * @param {number} radius crater radius
   * @param {number} [depthScale] depth multiplier (reserved for future shells)
   * @returns {number} total elevation removed (a cheap "destruction" metric)
   */
  function carve(terrain, cx, radius, depthScale) {
    var h = terrain.heights;
    var step = terrain.step;
    var depth = radius * CRATER_DEPTH_RATIO * (depthScale == null ? 1 : depthScale);
    var i0 = Math.max(0, Math.floor((cx - radius) / step));
    var i1 = Math.min(terrain.cols - 1, Math.ceil((cx + radius) / step));
    var dug = 0;

    for (var i = i0; i <= i1; i++) {
      var u = (i * step - cx) / radius;
      if (u <= -1 || u >= 1) continue;
      var cut = depth * Math.pow(1 - u * u, 1.5);
      var floorY = Math.max(C.CRATER_FLOOR, h[i] - cut);
      if (floorY < h[i]) {
        dug += h[i] - floorY;
        h[i] = floorY;
      }
    }

    limitSlope(h, i0 - 6, i1 + 6, TALUS * step);
    return dug;
  }

  /**
   * Order-sensitive checksum of a terrain, used by the determinism checks and
   * by the debug readout. Returns a hex string.
   */
  function checksum(terrain) {
    var h = 0x811c9dc5;
    for (var i = 0; i < terrain.cols; i++) {
      var q = Math.round(terrain.heights[i] * 1000) | 0;
      h ^= q;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  TE.terrain = {
    create: create,
    heightAt: heightAt,
    slopeAt: slopeAt,
    carve: carve,
    checksum: checksum
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
