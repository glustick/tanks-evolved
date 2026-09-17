/**
 * terrain.js — seeded heightfield generation, crater destruction, and the solid
 * cover that stands on the heightfield.
 *
 * The battlefield is a 1-D heightfield (one elevation sample every
 * CONST.TERRAIN_STEP world units). A heightfield cannot represent overhangs,
 * which makes it the classic Artillery-Duel shape: shells carve round bites
 * out of the ground, tanks may end up on a pillar or in a hole, and collision
 * tests stay trivial and exactly deterministic.
 *
 * Cover is the other half of the same idea and lives here for the same reason:
 * it is solid map geometry, it is derived from the seed, and it is tested against
 * a shell with closed-form arithmetic. Its base follows the live heightfield, so a
 * crater dug at its foot is filled by the block's foundation rather than leaving
 * it standing on air; its top does not move, which is what "static cover" means.
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

  // ------------------------------------------------------------------ cover
  // Three blocks are laid out on the left half of the band and each is mirrored
  // about the world centre, so the two sides are the same wall in the same place
  // and neither player is handed the better position. Three per half rather than
  // more: a wall every few dozen units stops reading as an obstacle and starts
  // reading as a fence.
  var COVER_HALF_COUNT = 3;
  var COVER_BAND_LO = 0.30;   // barriers stand between the spawn bands, never in one
  var COVER_BAND_HI = 0.70;
  var COVER_WIDTH_MIN = 24;
  var COVER_WIDTH_MAX = 44;
  var COVER_HEIGHT_MIN = 26;
  // The firing line. The roadmap offered two ways to keep a match winnable: leave a
  // gap in the band, or keep the cover below the arc. This is the second, because a
  // gap in x does not help a shell — a shell passes over each wall at that wall's own
  // x, so what it needs from cover is height, not width, and open ground between two
  // walls is a corridor nothing flies through.
  //
  // A full-power 45° shot reaches ~1557 units and the tanks spawn 900-1400 apart, so
  // this cap is what keeps the cross-map arc above every barrier. Measured against
  // the real terrain and both spawns over 50 seeds, the 45°/100 arc clears the
  // highest barrier top by 72 units at its tightest point (check 13 in
  // tools/check-determinism.js measures it).
  var COVER_HEIGHT_MAX = 52;
  var COVER_CENTRE_GAP = 20;  // clear ground either side of the world centre
  var COVER_CELL_MARGIN = 6;  // minimum open ground at the edge of a placement cell
  // How far a block runs on below the surface. Buried, so it is never seen — it
  // is what keeps the footing underground once a shell has blown the ground out
  // from in front of it, rather than leaving a gap under the near corner.
  var COVER_EMBED = 30;
  var COVER_CLEARANCE = 20;   // keep-out radius around a barrier, for a spawn

  /**
   * Seeded, mirrored cover layout, standing on the terrain it is given.
   *
   * A block's top is fixed where the layout puts it: the ground under it at the
   * start of the match, plus its height. Its *base* follows the live heightfield,
   * so the block grows downward as the ground is blown away at its foot and never
   * floats. That asymmetry is the whole of "static cover": digging under a wall
   * exposes its foundation, it does not sink it, and the wall's protection is the
   * same on the last turn as on the first. Reading the top off the live surface
   * instead would make craters a slow-motion way to destroy cover — the
   * destructible version this pass deliberately left out.
   *
   * The top depends on the terrain, so the layout is a function of the seed *and*
   * the terrain both. Both are derived from the seed and neither is mutated here,
   * so the layout is still identical wherever and whenever it is rebuilt.
   *
   * @param {number|string} seed
   * @param {object} terrain as returned by create()
   * @returns {Array<{x:number, w:number, h:number, base:number, mirror:boolean}>}
   */
  function createCover(seed, terrain) {
    if (!terrain) throw new Error('createCover needs the terrain its blocks stand on');
    var rng = TE.rng.derive(seed, 'cover');
    var centre = C.WORLD_W * 0.5;
    var lo = C.WORLD_W * COVER_BAND_LO;
    // Stop short of the centre so a mirrored pair can never overlap there.
    var hi = centre - COVER_CENTRE_GAP - COVER_WIDTH_MAX * 0.5;
    var cell = (hi - lo) / COVER_HALF_COUNT;
    var blocks = [];

    for (var i = 0; i < COVER_HALF_COUNT; i++) {
      var w = rng.range(COVER_WIDTH_MIN, COVER_WIDTH_MAX);
      var h = rng.range(COVER_HEIGHT_MIN, COVER_HEIGHT_MAX);
      // One block per cell, so two blocks can never be placed on top of each
      // other however the stream falls — no rejection loop, no unbounded draw.
      var cellLo = lo + i * cell + w * 0.5 + COVER_CELL_MARGIN;
      var cellHi = lo + (i + 1) * cell - w * 0.5 - COVER_CELL_MARGIN;
      var x = rng.range(cellLo, Math.max(cellLo, cellHi));
      // The footing is read once, here, and travels with the block from then on.
      blocks.push({ x: x, w: w, h: h, base: heightAt(terrain, x), mirror: false });
      blocks.push({
        x: C.WORLD_W - x, w: w, h: h,
        base: heightAt(terrain, C.WORLD_W - x), mirror: true
      });
    }
    return blocks;
  }

  /**
   * Order-sensitive checksum of a cover layout, in the same shape as
   * `checksum(terrain)` and for the same reason: `TE.game.stateHash()` has to
   * fold the walls in, or two clients can build different walls, agree about the
   * battlefield and never notice. Returns a hex string.
   *
   * The footing is hashed as well as the shape. It is not derivable any more once
   * the ground under a wall has been dug away, and two clients that placed the
   * same wall on different ground would stop shells in different places.
   */
  function coverChecksum(cover) {
    var h = 0x811c9dc5;
    var list = cover || [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var parts = [
        Math.round(b.x * 100) | 0,
        Math.round(b.w * 100) | 0,
        Math.round(b.h * 100) | 0,
        Math.round(b.base * 100) | 0
      ];
      for (var p = 0; p < parts.length; p++) {
        h ^= parts[p];
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /**
   * The rectangle a block occupies right now, in world units: a fixed top, and a
   * base that drops with the ground under it.
   */
  function coverRect(terrain, block) {
    var ground = heightAt(terrain, block.x);
    return {
      x0: block.x - block.w * 0.5,
      x1: block.x + block.w * 0.5,
      y0: Math.min(block.base, ground) - COVER_EMBED,
      y1: block.h + block.base
    };
  }

  /** Elevation of the top of a block, in world units. Fixed for the whole match. */
  function coverTop(block) {
    return block.base + block.h;
  }

  /** Does a vertical slab of half-width `clearance` at x overlap any block? */
  function coverBlocksX(cover, x, clearance) {
    var pad = clearance == null ? COVER_CLEARANCE : clearance;
    var list = cover || [];
    for (var i = 0; i < list.length; i++) {
      if (x + pad > list[i].x - list[i].w * 0.5 && x - pad < list[i].x + list[i].w * 0.5) return true;
    }
    return false;
  }

  /**
   * Where the segment (x0, y0) -> (x1, y1) enters a block, or null.
   *
   * Slab clipping rather than a point test: a shell travels up to ~2 units per
   * substep and the substep is not the unit the geometry is expressed in, so the
   * swept segment is what has to be tested — "a shell cannot pass through" is
   * then a property of the arithmetic rather than of the timestep being small.
   *
   * @returns {null|{x:number, y:number}} entry point
   */
  function coverHit(terrain, cover, x0, y0, x1, y1) {
    var list = cover || [];
    var dx = x1 - x0;
    var dy = y1 - y0;
    // Nearest entry first, so a shell crossing two blocks resolves against the
    // one it reached first.
    var best = null;
    var bestT = Infinity;

    for (var i = 0; i < list.length; i++) {
      var r = coverRect(terrain, list[i]);
      var lo = 0;
      var hi = 1;
      var t;

      if (dx === 0) {
        if (x0 < r.x0 || x0 > r.x1) continue;
      } else {
        var tx0 = (r.x0 - x0) / dx;
        var tx1 = (r.x1 - x0) / dx;
        if (tx0 > tx1) { t = tx0; tx0 = tx1; tx1 = t; }
        if (tx0 > lo) lo = tx0;
        if (tx1 < hi) hi = tx1;
        if (lo > hi) continue;
      }

      if (dy === 0) {
        if (y0 < r.y0 || y0 > r.y1) continue;
      } else {
        var ty0 = (r.y0 - y0) / dy;
        var ty1 = (r.y1 - y0) / dy;
        if (ty0 > ty1) { t = ty0; ty0 = ty1; ty1 = t; }
        if (ty0 > lo) lo = ty0;
        if (ty1 < hi) hi = ty1;
        if (lo > hi) continue;
      }

      if (lo < bestT) {
        bestT = lo;
        best = { x: x0 + dx * lo, y: y0 + dy * lo };
      }
    }
    return best;
  }

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
    checksum: checksum,
    createCover: createCover,
    coverChecksum: coverChecksum,
    coverRect: coverRect,
    coverTop: coverTop,
    coverBlocksX: coverBlocksX,
    coverHit: coverHit,
    // Exported so the determinism checks can assert against the shipped limits
    // instead of restating them, which is how a cap quietly stops being enforced.
    COVER_LIMITS: {
      heightMax: COVER_HEIGHT_MAX,
      clearance: COVER_CLEARANCE,
      halfCount: COVER_HALF_COUNT,
      bandLo: COVER_BAND_LO,
      bandHi: COVER_BAND_HI
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
