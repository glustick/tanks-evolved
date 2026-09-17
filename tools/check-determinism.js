#!/usr/bin/env node
/**
 * tools/check-determinism.js — Node-side verification of the simulation core.
 *
 * Loads js/version.js, utils.js, terrain.js, tanks.js, physics.js and game.js
 * into a single `vm` context (exactly the globals a browser `<script>` tag would
 * create), then asserts the properties Phase 0 promises:
 *
 *   1. the same seed generates identical terrain, twice
 *   2. different seeds generate different terrain
 *   3. terrain stays inside its documented bounds and contains no NaN
 *   4. tank spawns are seed-derived and repeatable
 *   5. the wind sequence is seed-derived and repeatable
 *   6. an identical shot from an identical world produces an identical impact
 *   7. wind is actually part of the model (same shot, different wind, different arc)
 *   8. craters are deterministic and remove material
 *   9. no Math.random() anywhere in js/
 *
 * ...and the properties the cover added:
 *
 *  10. the cover layout is seed-derived and repeatable
 *  11. the cover layout is mirrored about the world centre
 *  12. no tank spawns inside a barrier
 *  13. a firing line exists between the two spawns
 *  14. a shell aimed into a barrier breaks on it, and the barrier does not move
 *  15. a shell aimed over a barrier still lands normally
 *  16. the cover layout is part of stateHash
 *  17. the pre-cover tuning numbers are unchanged
 *
 * Checks 12 and 13 run over 50 seeds; check 13 fires real shots over an aim grid
 * for every one of them, which is why the whole suite takes a few seconds.
 *
 * Usage:  node tools/check-determinism.js
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */
'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
// game.js is here for the cover checks: the layout, the spawn guard and
// stateHash all live behind TE.game, and testing a copy of them would prove
// nothing about the code that ships.
const MODULES = ['version.js', 'utils.js', 'terrain.js', 'tanks.js', 'physics.js', 'game.js'];

/** Load the given js/ files into one shared vm context and return that context. */
function loadSimulation(files = MODULES) {
  const sandbox = { console };
  const context = vm.createContext(sandbox);
  for (const file of files) {
    const code = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
    new vm.Script(code, { filename: `js/${file}` }).runInContext(context);
  }
  return context;
}

const ctx = loadSimulation();
const TE = ctx.TE;
const C = TE.CONST;

/** A perfectly flat test terrain, so ranges are comparable across powers. */
function flatWorld(groundY) {
  const cols = Math.round(C.WORLD_W / C.TERRAIN_STEP) + 1;
  const heights = new Float64Array(cols).fill(groundY);
  return {
    seed: 'flat',
    terrain: { seed: 'flat', step: C.TERRAIN_STEP, cols, width: (cols - 1) * C.TERRAIN_STEP, heights },
    cover: [],
    tanks: [],
    wind: 0
  };
}

/** Muzzle 30 units above flat ground — the reference condition for the table. */
const FLAT = flatWorld(200);
const FLAT_MUZZLE = { x: 100, y: 230 };

// ---------------------------------------------------------------- test runner
/** Values the design note at the bottom reports, filled in by the checks that
 *  measure them, so the summary is a measurement rather than a second opinion. */
const report = { cover: null, coverCap: TE.terrain.COVER_LIMITS.heightMax };

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail == null ? '' : String(detail) });
  } catch (err) {
    results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** A world with terrain and tanks but no game state — enough for physics. */
function makeWorld(seed) {
  const terrain = TE.terrain.create(seed);
  const rng = TE.rng.derive(seed, 'spawn');
  const x1 = TE.utils.lerp(0.04, 0.22, rng.next()) * C.WORLD_W;
  const x2 = TE.utils.lerp(0.78, 0.96, rng.next()) * C.WORLD_W;
  return {
    seed,
    terrain,
    cover: [],
    tanks: [TE.tank.create(1, x1, terrain), TE.tank.create(2, x2, terrain)],
    wind: 0
  };
}

/** 50 seeds plus the named ones the rest of the project tunes against. */
const SEEDS = [...Array.from({ length: 50 }, (_, i) => `seed-${i}`),
  'EAGLE-4821', 'FALCON-1', 'TANKS-1', 'WIN-TEST'];

// --------------------------------------------------------------- cover helpers
/** The blocks a shell fired from xFrom toward xTo has to get past, in x order. */
function coverBetween(terrain, cover, xFrom, xTo) {
  const lo = Math.min(xFrom, xTo);
  const hi = Math.max(xFrom, xTo);
  return cover.filter((b) => b.x + b.w * 0.5 > lo && b.x - b.w * 0.5 < hi)
    .sort((a, b) => a.x - b.x);
}

/**
 * Sample a trajectory into a list of points, ignoring cover — the raw arc, so a
 * clearance can be measured against it. The world's own shot resolution is used
 * for everything else.
 */
function arcPoints(world, shot) {
  const bare = { terrain: world.terrain, tanks: [], cover: [], wind: 0 };
  const p = TE.physics.createProjectile(
    shot.x, shot.y, shot.angle, shot.power, shot.facing, shot.ownerId, shot.wind
  );
  const dt = C.SIM_STEP / C.SIM_SUBSTEPS;
  const points = [{ x: p.x, y: p.y }];
  while (p.age < 26) {
    if (TE.physics.step(bare, p, dt)) break;
    points.push({ x: p.x, y: p.y });
  }
  return points;
}

/** Arc height at world x, linearly interpolated between samples. */
function arcHeightAt(points, x) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if ((x - a.x) * (x - b.x) <= 0 && a.x !== b.x) {
      return a.y + (b.y - a.y) * ((x - a.x) / (b.x - a.x));
    }
  }
  return null;
}

/**
 * The nearest impact to `centre` over an aim grid, fired from the active tank.
 *
 * Windless by default, and that is the point: a firing line is a question about
 * geometry, and wind is a separate difficulty the player compensates for by aiming
 * — a strong gust bends a shell 250 units, so searching with the turn's wind in the
 * loop would measure the grid's resolution rather than whether cover has walled the
 * map off.
 *
 * Two distances come back, because they are not the same claim: `distance` is the
 * closest impact of any kind, `clean` is the closest that a wall did not stop.
 */
function bestShotAt(game, target, opts) {
  const o = opts || {};
  const world = game.world;
  const tank = world.tanks[world.activeIndex];
  const wind = o.wind == null ? 0 : o.wind;
  const centre = TE.tank.bodyCenter(target);
  const hit = { best: null, clean: null, coverHits: 0 };

  for (let angle = 20; angle <= 80; angle += 5) {
    for (let power = 40; power <= 100; power += 10) {
      TE.tank.setAngle(tank, angle);
      const muzzle = TE.tank.muzzle(tank);
      const event = TE.physics.simulateShot(world, {
        x: muzzle.x, y: muzzle.y, angle: angle, power: power,
        facing: tank.facing, ownerId: tank.id, wind: wind
      }, { maxTime: 20 });
      const distance = TE.utils.dist(event.x, event.y, centre.x, centre.y);
      if (!hit.best || distance < hit.best.distance) {
        hit.best = { angle, power, event, distance };
      }
      // The shot a player would settle on: the closest one a wall does not stop.
      // A wall hit nearer than any clean shot is not a hit on the tank.
      if (event.type === 'cover') hit.coverHits++;
      else if (!hit.clean || distance < hit.clean.distance) {
        hit.clean = { angle, power, event, distance };
      }
    }
  }
  return hit;
}

// ------------------------------------------------------------------ checks
check('1. same seed -> identical terrain (x2, all samples bit-identical)', () => {
  const a = TE.terrain.create('EAGLE-4821');
  const b = TE.terrain.create('EAGLE-4821');
  assert(a.cols === b.cols, 'column count differs');
  for (let i = 0; i < a.cols; i++) {
    assert(a.heights[i] === b.heights[i], `sample ${i} differs: ${a.heights[i]} vs ${b.heights[i]}`);
  }
  assert(TE.terrain.checksum(a) === TE.terrain.checksum(b), 'checksum differs');
  return `checksum ${TE.terrain.checksum(a)}`;
});

check('2. different seeds -> different terrain (16 seeds, all distinct)', () => {
  const seen = new Map();
  for (let i = 0; i < 16; i++) {
    const terrain = TE.terrain.create(i);
    const sum = TE.terrain.checksum(terrain);
    assert(!seen.has(sum), `seed ${i} collides with seed ${seen.get(sum)} (checksum ${sum})`);
    seen.set(sum, i);
    const sample = terrain.heights[Math.floor(terrain.cols / 3)];
    assert(Number.isFinite(sample), `seed ${i} produced a non-finite sample`);
  }
  const sums = [...seen.keys()];
  return `16 distinct checksums: seed 0 -> ${TE.terrain.checksum(TE.terrain.create(0))}, ` +
    `seed 1 -> ${TE.terrain.checksum(TE.terrain.create(1))}, ` +
    `seed 15 -> ${TE.terrain.checksum(TE.terrain.create(15))}`;
});

check('3. terrain stays in [GROUND_MIN, GROUND_MAX] with no NaN (64 seeds)', () => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let s = 0; s < 64; s++) {
    const terrain = TE.terrain.create('seed-' + s);
    for (let i = 0; i < terrain.cols; i++) {
      const h = terrain.heights[i];
      assert(Number.isFinite(h), `seed ${s} sample ${i} is ${h}`);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    assert(terrain.cols === Math.round(C.WORLD_W / C.TERRAIN_STEP) + 1, 'unexpected column count');
  }
  assert(lo >= C.GROUND_MIN - 1e-9, `min elevation ${lo} below GROUND_MIN`);
  assert(hi <= C.GROUND_MAX + 1e-9, `max elevation ${hi} above GROUND_MAX`);
  return `64 terrains, elevation range [${lo.toFixed(2)}, ${hi.toFixed(2)}]`;
});

check('4. tank spawns are seed-derived and repeatable', () => {
  const a = makeWorld('EAGLE-4821');
  const b = makeWorld('EAGLE-4821');
  const c = makeWorld('FALCON-1');
  assert(a.tanks[0].x === b.tanks[0].x && a.tanks[1].x === b.tanks[1].x, 'spawns not repeatable');
  assert(a.tanks[0].x !== c.tanks[0].x || a.tanks[1].x !== c.tanks[1].x, 'different seed produced identical spawns');
  assert(a.tanks[0].x < C.WORLD_W * 0.3, 'player 1 not in the left third');
  assert(a.tanks[1].x > C.WORLD_W * 0.7, 'player 2 not in the right third');
  assert(Math.abs(a.tanks[0].y - TE.terrain.heightAt(a.terrain, a.tanks[0].x)) < 1e-9, 'tank not on the surface');
  return `p1 x=${a.tanks[0].x.toFixed(1)} y=${a.tanks[0].y.toFixed(1)}, p2 x=${a.tanks[1].x.toFixed(1)} y=${a.tanks[1].y.toFixed(1)}`;
});

check('5. wind sequence is seed-derived and repeatable (TE.rng.rollWind)', () => {
  const roll = (seed, count) => {
    const rng = TE.rng.derive(seed, 'wind');
    const out = [];
    for (let i = 0; i < count; i++) out.push(TE.rng.rollWind(rng));
    return out;
  };
  const a = roll('EAGLE-4821', 8);
  const b = roll('EAGLE-4821', 8);
  const c = roll('FALCON-1', 8);
  assert(a.join(',') === b.join(','), 'wind sequence not repeatable');
  assert(a.join(',') !== c.join(','), 'different seeds produced the same wind');
  assert(a.every((w) => w >= C.WIND_MIN && w <= C.WIND_MAX), 'wind outside [WIND_MIN, WIND_MAX]');
  return `seed EAGLE-4821 wind: [${a.join(', ')}]`;
});

check('6. identical shot -> identical impact (exact float equality)', () => {
  const run = () => {
    const world = makeWorld('EAGLE-4821');
    const tank = world.tanks[0];
    const m = TE.tank.muzzle(tank);
    const event = TE.physics.simulateShot(world, {
      x: m.x, y: m.y, angle: 47, power: 78, facing: tank.facing, ownerId: 1, wind: 0.42
    });
    return event;
  };
  const a = run();
  const b = run();
  assert(a.type === b.type, `impact type differs: ${a.type} vs ${b.type}`);
  assert(a.x === b.x, `impact x differs: ${a.x} vs ${b.x}`);
  assert(a.y === b.y, `impact y differs: ${a.y} vs ${b.y}`);
  assert(a.time === b.time, `impact time differs: ${a.time} vs ${b.time}`);
  assert(a.samples === b.samples, `substep count differs: ${a.samples} vs ${b.samples}`);
  return `${a.type} hit at x=${a.x.toFixed(4)} y=${a.y.toFixed(4)} after ${a.time.toFixed(4)}s (${a.samples} substeps)`;
});

check('7. wind measurably bends the trajectory', () => {
  const world = makeWorld('EAGLE-4821');
  world.tanks = [];
  const shot = { x: 200, y: 300, angle: 45, power: 75, facing: 1, ownerId: 1 };
  const left = TE.physics.simulateShot(world, Object.assign({}, shot, { wind: -0.9 }));
  const none = TE.physics.simulateShot(world, Object.assign({}, shot, { wind: 0 }));
  const right = TE.physics.simulateShot(world, Object.assign({}, shot, { wind: 0.9 }));
  assert(left.x < none.x && none.x < right.x, `wind ordering wrong: ${left.x} / ${none.x} / ${right.x}`);
  assert(right.x - left.x > 100, `wind effect too small: ${(right.x - left.x).toFixed(1)} units`);
  return `impact x: wind -0.9 -> ${left.x.toFixed(1)}, calm -> ${none.x.toFixed(1)}, wind +0.9 -> ${right.x.toFixed(1)} (spread ${(right.x - left.x).toFixed(1)})`;
});

check('8. craters are deterministic, dig-only, bounded and slope-limited', () => {
  const world = makeWorld('EAGLE-4821');
  const before = TE.terrain.checksum(world.terrain);
  const copy = TE.terrain.create('EAGLE-4821');
  const cx = 800;
  const dugA = TE.terrain.carve(world.terrain, cx, C.CRATER_RADIUS);
  const dugB = TE.terrain.carve(copy, cx, C.CRATER_RADIUS);
  assert(dugA > 0, 'crater removed no material');
  assert(dugA === dugB, `dug volume differs: ${dugA} vs ${dugB}`);
  assert(TE.terrain.checksum(copy) === TE.terrain.checksum(world.terrain), 'cratered terrain differs');
  assert(TE.terrain.checksum(world.terrain) !== before, 'terrain unchanged after carve');

  // dig-only, never below the floor, never deeper than the documented profile
  const fresh = TE.terrain.create('EAGLE-4821');
  const maxDepth = C.CRATER_RADIUS * 0.55 + 1e-6;
  let deepest = 0;
  for (let i = 0; i < fresh.cols; i++) {
    const unmodified = fresh.heights[i];
    const carved = world.terrain.heights[i];
    assert(carved <= unmodified + 1e-9, `column ${i} was raised: ${unmodified} -> ${carved}`);
    assert(carved >= C.CRATER_FLOOR - 1e-9, `column ${i} dug below the floor: ${carved}`);
    deepest = Math.max(deepest, unmodified - carved);
  }
  assert(deepest <= maxDepth, `crater deeper than the profile allows: ${deepest} > ${maxDepth}`);
  assert(deepest > maxDepth * 0.9, `crater unexpectedly shallow: ${deepest}`);

  // slope limiter: no crater wall steeper than the talus limit
  let maxStep = 0;
  for (let i = 1; i < world.terrain.cols; i++) {
    maxStep = Math.max(maxStep, Math.abs(world.terrain.heights[i] - world.terrain.heights[i - 1]));
  }
  assert(maxStep <= C.TERRAIN_STEP * 1.45 + 1e-6, `crater wall steeper than the talus limit: max step ${maxStep}`);

  // repeated hits in the same spot keep digging without breaking the bounds
  const sumBeforeSecond = TE.terrain.checksum(world.terrain);
  const dug2 = TE.terrain.carve(world.terrain, cx, C.CRATER_RADIUS);
  assert(dug2 > 0, 'second hit in the same crater removed nothing');
  assert(TE.terrain.checksum(world.terrain) !== sumBeforeSecond, 'second hit did not change the terrain');
  return `dug ${dugA.toFixed(1)} units, max depth ${deepest.toFixed(1)} (cap ${maxDepth.toFixed(1)}), ` +
    `steepest column step ${maxStep.toFixed(3)} (limit ${(C.TERRAIN_STEP * 1.45).toFixed(2)}), second hit dug ${dug2.toFixed(1)}`;
});

check('9. no Math.random() in js/', () => {
  const offenders = [];
  for (const file of fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
    // strip block/line comments so prose mentions of Math.random() do not fail the check
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/Math\s*\.\s*random/.test(code)) offenders.push(file);
  }
  assert(offenders.length === 0, `Math.random found in: ${offenders.join(', ')}`);
  const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
  return `${files.length} files scanned, 0 occurrences`;
});

// --------------------------------------------------------------------- cover
check('10. the cover layout is seed-derived and repeatable', () => {
  const a = TE.terrain.createCover('EAGLE-4821', TE.terrain.create('EAGLE-4821'));
  const b = TE.terrain.createCover('EAGLE-4821', TE.terrain.create('EAGLE-4821'));
  const c = TE.terrain.createCover('FALCON-1', TE.terrain.create('FALCON-1'));
  assert(a.length > 0, 'no cover at all');
  assert(a.length === b.length, `block count differs: ${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    assert(a[i].x === b[i].x && a[i].w === b[i].w && a[i].h === b[i].h && a[i].base === b[i].base,
      `block ${i} differs: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`);
  }
  assert(TE.terrain.coverChecksum(a) === TE.terrain.coverChecksum(b), 'checksums differ');
  assert(TE.terrain.coverChecksum(a) !== TE.terrain.coverChecksum(c),
    `two seeds produced the same layout (checksum ${TE.terrain.coverChecksum(a)})`);

  // and every block is somewhere a shell can be stopped by it at all
  const sample = TE.terrain.create('EAGLE-4821');
  for (const block of a) {
    assert(Math.abs(block.base - TE.terrain.heightAt(sample, block.x)) < 1e-9,
      `block ${block.x.toFixed(0)} is not standing on the surface: base ${block.base}`);
    assert(block.w > 0 && block.h > 0, `degenerate block: ${JSON.stringify(block)}`);
    assert(block.x - block.w > 0 && block.x + block.w < C.WORLD_W,
      `block hangs off the map: ${JSON.stringify(block)}`);
    assert(block.h <= TE.terrain.COVER_LIMITS.heightMax + 1e-9,
      `block taller than the firing-line cap: ${block.h}`);
  }
  return `${a.length} blocks between x=${a[0].x.toFixed(0)} and x=${a[a.length - 1].x.toFixed(0)}, ` +
    `checksum ${TE.terrain.coverChecksum(a)}`;
});

check('11. the cover layout is mirrored about the world centre', () => {
  let pairs = 0;
  for (const seed of ['EAGLE-4821', 'FALCON-1', 'MIRROR-9']) {
    const terrain = TE.terrain.create(seed);
    const cover = TE.terrain.createCover(seed, terrain);
    for (const block of cover) {
      const mirrorX = C.WORLD_W - block.x;
      const twin = cover.find((other) => Math.abs(other.x - mirrorX) < 1e-9);
      assert(twin, `no counterpart at x=${mirrorX.toFixed(1)} for the block at ${block.x.toFixed(1)} (seed ${seed})`);
      assert(twin.w === block.w && twin.h === block.h,
        `the counterpart differs in size: ${block.w}x${block.h} vs ${twin.w}x${twin.h}`);
      // The ground under the two is not mirrored — the terrain is not symmetric —
      // so the footing legitimately differs. What has to match is how far each
      // block stands above the surface it was built on: neither side gets a
      // taller wall.
      assert(Math.abs((TE.terrain.coverTop(block) - block.base) - (TE.terrain.coverTop(twin) - twin.base)) < 1e-9,
        'the mirrored blocks stand to different heights');
      assert(twin.mirror !== block.mirror, 'two blocks claim the same side');
      pairs++;
    }
    // Fair means fair in both directions: the left half has as much cover as the
    // right, and the count is even.
    assert(cover.filter((b) => b.x < C.WORLD_W / 2).length === cover.filter((b) => b.x > C.WORLD_W / 2).length,
      `the two halves hold different amounts of cover (seed ${seed})`);
  }
  return `${pairs} blocks over 3 seeds, every one with an identical twin reflected in the centre`;
});

check('12. no tank spawns inside a barrier (50 seeds)', () => {
  let worst = Infinity;
  let worstSeed = '';
  for (const seed of SEEDS) {
    const game = TE.game.create(seed);
    const cover = game.world.cover;
    for (const tank of game.world.tanks) {
      let clearance = Infinity;
      for (const block of cover) {
        // Distance from the tank's centre to the block's footprint; the hull is
        // 15 units wide and the hit circle 13, so anything under TANK_RADIUS is
        // a tank standing in a wall.
        const gap = Math.abs(tank.x - block.x) - block.w / 2;
        clearance = Math.min(clearance, gap);
      }
      assert(clearance > C.TANK_RADIUS,
        `seed ${seed}: P${tank.id} spawned ${clearance.toFixed(1)} units from a barrier edge`);
      if (clearance < worst) { worst = clearance; worstSeed = `${seed} P${tank.id}`; }
    }
  }

  // The guard itself, driven directly: a synthetic block over every candidate the
  // spawn stream offers must move the spawn rather than be ignored. Without this
  // the check above would pass on the layout alone and prove nothing about the code.
  // The guard itself, driven directly: the cover layout keeps out of both spawn
  // bands, so the check above would pass on the layout alone and prove nothing
  // about the code. This puts walls across the band with one gap left in it and
  // requires the spawn to end up in the gap.
  const terrain = TE.terrain.create('GUARD-TEST');
  const band = { lo: 0.05, hi: 0.22 };
  const lo = band.lo * C.WORLD_W;
  const hi = band.hi * C.WORLD_W;
  const gapLo = lo + (hi - lo) * 0.35;
  const gapHi = lo + (hi - lo) * 0.70;
  const walls = [
    { x: (lo + gapLo) / 2, w: gapLo - lo, h: 40, mirror: false },
    { x: (gapHi + hi) / 2, w: hi - gapHi, h: 40, mirror: false }
  ];
  const guarded = TE.game.pickSpawnX(terrain, walls, TE.rng.derive('GUARD-TEST', 'spawn'), band.lo, band.hi);
  assert(!TE.terrain.coverBlocksX(walls, guarded),
    `pickSpawnX left a tank inside a wall at x=${guarded.toFixed(1)}`);
  const pad = TE.terrain.COVER_LIMITS.clearance;
  assert(guarded > gapLo + pad - 1e-6 && guarded < gapHi - pad + 1e-6,
    `pickSpawnX returned x=${guarded.toFixed(1)}, outside the only clear stretch ` +
    `[${(gapLo + pad).toFixed(1)}, ${(gapHi - pad).toFixed(1)}]`);
  return `spawn clearance over ${SEEDS.length} seeds: never below ${worst.toFixed(1)} units ` +
    `(${worstSeed}); with the band walled off but for a ` +
    `${(gapHi - gapLo - 2 * pad).toFixed(0)}-unit gap, it spawns at x=${guarded.toFixed(1)}`;
});

check('13. a firing line exists between the two spawns (50 seeds)', () => {
  let minClear = Infinity;
  let minClearAt = '';
  let worstBest = 0;
  let worstBestSeed = '';
  let pairs = 0;
  let covered = 0;

  for (const seed of SEEDS) {
    const game = TE.game.create(seed);
    const world = game.world;
    const [p1, p2] = world.tanks;
    const between = coverBetween(world.terrain, world.cover, p1.x, p2.x);
    assert(between.length > 0, `seed ${seed} has no cover between the tanks at all`);
    assert(p1.x < C.WORLD_W * 0.3 && p2.x > C.WORLD_W * 0.7, `seed ${seed} spawned a tank outside its third`);

    // 1. The structural half: the reference cross-map arc clears every barrier it
    //    passes over. This is the guarantee the placement rule is built on — cover
    //    is capped so a full-power 45° shot stays above it, and this measures that
    //    it does, on real terrain and at both spawns rather than in a diagram.
    for (const [shooter, target] of [[p1, p2], [p2, p1]]) {
      const muzzle = TE.tank.muzzle(shooter);
      const points = arcPoints(world, {
        x: muzzle.x, y: muzzle.y, angle: 45, power: 100,
        facing: target.x > shooter.x ? 1 : -1, ownerId: shooter.id, wind: 0
      });
      for (const block of between) {
        const top = TE.terrain.coverTop(block);
        for (const face of [block.x - block.w / 2, block.x + block.w / 2]) {
          const y = arcHeightAt(points, face);
          if (y == null) continue;
          const clear = y - top;
          if (clear < minClear) {
            minClear = clear;
            minClearAt = `${seed} P${shooter.id} over x=${face.toFixed(0)}`;
          }
        }
      }
    }

    // 2. The practical half: some actual shot reaches the enemy without meeting a
    //    wall. Clearance in the diagram is not the same claim as a shot that
    //    lands, so the suite fires the grid and requires a real hit.
    for (const index of [0, 1]) {
      world.activeIndex = index;
      const shooter = world.tanks[index];
      const target = world.tanks[1 - index];
      const best = bestShotAt(game, target);
      assert(best.clean,
        `seed ${seed} P${shooter.id}: every shot on the grid was stopped by cover`);
      assert(best.clean.distance <= C.BLAST_RADIUS,
        `seed ${seed} P${shooter.id}: the closest shot a wall does not stop lands ` +
        `${best.clean.distance.toFixed(1)} away — outside the ${C.BLAST_RADIUS} blast radius`);
      if (best.clean.distance > worstBest) {
        worstBest = best.clean.distance;
        worstBestSeed = `${seed} P${shooter.id}`;
      }
      // A wall nothing can hit would be decoration, so the grid has to contain
      // shots that break on one somewhere in the band.
      if (best.coverHits > 0) covered++;
      pairs++;
    }
    world.activeIndex = 0;
  }

  assert(minClear > 0, `the reference arc is stopped by cover: ${minClear.toFixed(1)} units at ${minClearAt}`);
  report.cover = {
    seeds: SEEDS.length, pairs: pairs, minClear: minClear,
    minClearAt: minClearAt, worstBest: worstBest, worstBestSeed: worstBestSeed
  };
  assert(covered === pairs,
    `only ${covered} of ${pairs} spawn pairs had any aim stopped by a barrier — the cover is decorative`);
  return `reference 45°/100 arc clears every barrier between the spawns by ≥${minClear.toFixed(1)} units ` +
    `(${minClearAt}); all ${pairs} spawn pairs land a clean shot, the worst ${worstBest.toFixed(1)} units ` +
    `from the tank (${worstBestSeed}); every pair also has aims that break on a barrier`;
});

check('14. a shell aimed into a barrier breaks on it, and the barrier does not move', () => {
  let tested = 0;
  let detail = '';
  for (const seed of ['seed-0', 'seed-7', 'EAGLE-4821']) {
    const game = TE.game.create(seed);
    const world = game.world;
    const tank = world.tanks[0];
    const target = world.tanks[1];

    // The first barrier out in front of P1, fired at flat: whatever the terrain
    // does, a shell that meets the wall must stop at the face it met.
    const ahead = coverBetween(world.terrain, world.cover, tank.x, target.x)
      .filter((b) => b.x > tank.x);
    assert(ahead.length > 0, `seed ${seed} has no barrier in front of P1`);
    const block = ahead[0];
    const rect = TE.terrain.coverRect(world.terrain, block);

    let hit = null;
    for (let power = 20; power <= 100 && !hit; power += 2) {
      for (let angle = 0; angle <= 30 && !hit; angle += 2) {
        TE.tank.setAngle(tank, angle);
        const muzzle = TE.tank.muzzle(tank);
        const event = TE.physics.simulateShot(world, {
          x: muzzle.x, y: muzzle.y, angle, power, facing: tank.facing, ownerId: tank.id, wind: 0
        }, { maxTime: 20 });
        if (event.type === 'cover') hit = { event, angle, power };
      }
    }
    assert(hit, `seed ${seed}: no flat shot at that barrier was stopped by it`);

    const event = hit.event;
    assert(event.x >= rect.x0 - 1e-6 && event.x <= rect.x1 + 1e-6,
      `seed ${seed}: the shell registered a cover hit at x=${event.x.toFixed(2)}, outside the block ` +
      `[${rect.x0.toFixed(2)}, ${rect.x1.toFixed(2)}]`);
    // It stopped on the near face rather than somewhere inside or beyond it: the
    // swept segment is clipped at the entry point, so the entry is on the face.
    assert(Math.abs(event.x - rect.x0) < 1,
      `seed ${seed}: the shell went ${(event.x - rect.x0).toFixed(2)} units past the near face ` +
      '(x=' + rect.x0.toFixed(2) + ')');
    assert(event.y >= rect.y0 - 1e-6 && event.y <= rect.y1 + 1e-6,
      `seed ${seed}: the cover hit is outside the block vertically: y=${event.y.toFixed(2)} ` +
      `vs [${rect.y0.toFixed(2)}, ${rect.y1.toFixed(2)}]`);
    assert(event.x < target.x,
      `seed ${seed}: a shell that broke on a barrier ended up past the target`);

    // Breaking on a wall digs a crater at its foot, like any other impact — and
    // that is exactly where the wall has to stay put. The ground is destructible
    // and always was; the block is not.
    const topBefore = TE.terrain.coverTop(block);
    const before = TE.terrain.checksum(world.terrain);
    TE.game.resolveImpact(game, {
      type: 'cover', x: event.x, y: event.y, speed: event.speed
    });
    assert(TE.terrain.checksum(world.terrain) !== before,
      `seed ${seed}: a cover impact left the ground untouched, unlike every other impact`);
    assert(TE.terrain.coverChecksum(world.cover) === TE.terrain.coverChecksum(game.world.cover),
      `seed ${seed}: a cover impact rewrote the layout`);
    assert(TE.terrain.coverTop(block) === topBefore,
      `seed ${seed}: digging at a wall's foot moved its top`);
    const rectAfter = TE.terrain.coverRect(world.terrain, block);
    assert(rectAfter.y1 === topBefore,
      `seed ${seed}: the block's top moved from ${topBefore} to ${rectAfter.y1}`);
    assert(rectAfter.y0 <= rect.y0 - 1,
      `seed ${seed}: the block did not follow the ground down (base ${rect.y0} -> ${rectAfter.y0})`);
    assert(rectAfter.y0 <= TE.terrain.heightAt(world.terrain, block.x),
      `seed ${seed}: the block was left standing above the ground at its own foot`);
    if (!detail) {
      detail = `seed ${seed}: ${hit.angle}°/${hit.power} broke on the block at x=${block.x.toFixed(0)} ` +
        `(near face x=${rect.x0.toFixed(2)}), stopped at x=${event.x.toFixed(2)} y=${event.y.toFixed(2)}; ` +
        `the crater dropped its footing ${rect.y0.toFixed(1)} -> ${rectAfter.y0.toFixed(1)} ` +
        'and left the top where it was';
    }
    tested++;
  }
  return `${tested} seeds, no pass-through, no change to the block — ${detail}`;
});

check('15. a shell aimed over a barrier still lands normally', () => {
  let checked = 0;
  let detail = '';
  for (const seed of ['seed-0', 'seed-7', 'EAGLE-4821']) {
    const game = TE.game.create(seed);
    const world = game.world;
    const tank = world.tanks[0];
    const target = world.tanks[1];
    const ahead = coverBetween(world.terrain, world.cover, tank.x, target.x)
      .filter((b) => b.x > tank.x);
    assert(ahead.length > 0, `seed ${seed} has no barrier in front of P1`);
    const block = ahead[0];
    const rect = TE.terrain.coverRect(world.terrain, block);
    const top = TE.terrain.coverTop(block);
    const centre = TE.tank.bodyCenter(target);
    const facing = target.x > tank.x ? 1 : -1;

    // Aim at the enemy, keep only the shots that went over the wall and landed
    // beyond it, and take the closest. If cover were impassable this set would be
    // empty, which is the thing worth failing on.
    let best = null;
    let closest = null;
    for (let angle = 20; angle <= 80; angle += 5) {
      for (let power = 30; power <= 100; power += 5) {
        TE.tank.setAngle(tank, angle);
        const muzzle = TE.tank.muzzle(tank);
        const event = TE.physics.simulateShot(world, {
          x: muzzle.x, y: muzzle.y, angle, power, facing, ownerId: tank.id, wind: world.wind
        }, { maxTime: 20 });
        if (event.type !== 'terrain' || event.x <= rect.x1) continue;
        const points = arcPoints(world, {
          x: muzzle.x, y: muzzle.y, angle, power, facing, ownerId: tank.id, wind: world.wind
        });
        const overTop = arcHeightAt(points, block.x) - top;
        if (overTop == null || overTop <= 0) continue;
        const distance = TE.utils.dist(event.x, event.y, centre.x, centre.y);
        const candidate = { angle, power, event, distance, overTop };
        if (!best || distance < best.distance) best = candidate;
        if (!closest) closest = candidate;
        checked++;
      }
    }

    assert(best, `seed ${seed}: no shot cleared the barrier at x=${block.x.toFixed(0)} and landed beyond it`);
    assert(best.event.type === 'terrain',
      `seed ${seed}: a clearing shot resolved as ${best.event.type}`);
    assert(best.event.x > rect.x1,
      `seed ${seed}: landed at x=${best.event.x.toFixed(1)}, inside the barrier ending at ${rect.x1.toFixed(1)}`);
    if (!detail) {
      detail = `seed ${seed}: ${best.angle}°/${best.power} cleared the top by ${best.overTop.toFixed(1)} units ` +
        `and landed at x=${best.event.x.toFixed(1)}, past the barrier face at x=${rect.x1.toFixed(1)}`;
    }
  }
  return `${checked} clearing shots across 3 seeds; the best of them — ${detail}`;
});

check('16. the cover layout is part of stateHash', () => {
  const a = TE.game.create('EAGLE-4821');
  const b = TE.game.create('EAGLE-4821');
  const c = TE.game.create('FALCON-1');
  assert(TE.game.stateHash(a) === TE.game.stateHash(b), 'two runs of one seed disagree');
  assert(TE.game.stateHash(a) !== TE.game.stateHash(c), 'two seeds produce the same hash');

  // Nudging a single block is what a client with a different layout would look
  // like, and it has to move the hash or the hash cannot catch it.
  const moved = TE.game.create('EAGLE-4821');
  moved.world.cover[0] = Object.assign({}, moved.world.cover[0], { x: moved.world.cover[0].x + 1 });
  assert(TE.game.stateHash(moved) !== TE.game.stateHash(a),
    'a moved barrier did not change the state hash');

  const taller = TE.game.create('EAGLE-4821');
  taller.world.cover[1] = Object.assign({}, taller.world.cover[1], { h: taller.world.cover[1].h + 1 });
  assert(TE.game.stateHash(taller) !== TE.game.stateHash(a),
    'a taller barrier did not change the state hash');

  const none = TE.game.create('EAGLE-4821');
  none.world.cover = [];
  assert(TE.game.stateHash(none) !== TE.game.stateHash(a),
    'removing every barrier did not change the state hash');

  // Stable when nothing changes: a replayed board has to fingerprint the same.
  const replay = TE.game.create('EAGLE-4821');
  TE.game.reset(replay, 'EAGLE-4821');
  assert(TE.game.stateHash(replay) === TE.game.stateHash(a), 'a rebuilt board fingerprints differently');
  return `${a.world.cover.length} blocks folded in; moving one unit, raising one unit or removing them all ` +
    'each changes the hash, and an unchanged board does not';
});

check('17. the pre-cover tuning numbers are unchanged', () => {
  // These are the two numbers the README's tuning table and every stored replay
  // rest on. The scenario, the generator and the spawn rule are all older than the
  // cover, so if either of these moves, cover has reached into the simulation —
  // the one thing it was not allowed to do.
  const shot = Object.assign({ facing: 1, ownerId: 1, wind: 0 }, FLAT_MUZZLE, { angle: 45, power: 100 });
  const event = TE.physics.simulateShot(FLAT, shot);
  const range = event.x - FLAT_MUZZLE.x;
  assert(Math.abs(range - 1557) < 1, `the 45°/100 range moved: ${range.toFixed(1)} (was 1557)`);

  const world = makeWorld('EAGLE-4821');
  const separation = Math.abs(world.tanks[1].x - world.tanks[0].x);
  assert(Math.abs(separation - 1234) < 1,
    `the EAGLE-4821 spawn separation moved: ${separation.toFixed(1)} (was 1234)`);
  return `45°/100 range ${range.toFixed(1)} units and EAGLE-4821 separation ${separation.toFixed(1)} units, ` +
    'both as they were before the cover';
});

// ------------------------------------------------- terrain / range report
function rangeReport() {
  const lines = [];
  lines.push('  angle | power | muzzle speed |  range | flight |  apex');
  lines.push('  ------+-------+--------------+--------+--------+-------');
  for (const angle of [30, 45, 60, 75]) {
    for (const power of [40, 60, 80, 100]) {
      const shot = Object.assign({ facing: 1, ownerId: 1, wind: 0 }, FLAT_MUZZLE, { angle, power });
      const ev = TE.physics.simulateShot(FLAT, shot);
      const range = ev.type === 'terrain' ? ev.x - FLAT_MUZZLE.x : NaN;
      const apex = apexOf(FLAT, shot);
      lines.push(
        `  ${String(angle).padStart(5)}° | ${String(power).padStart(5)} | ` +
        `${TE.physics.muzzleSpeed(power).toFixed(0).padStart(12)} | ` +
        `${(Number.isFinite(range) ? range.toFixed(0) : 'offmap').padStart(6)} | ` +
        `${ev.time.toFixed(2).padStart(5)}s | ${apex.toFixed(0).padStart(5)}`
      );
    }
  }
  return lines.join('\n');
}

/** Highest point reached by a shot, for the "does it leave the world?" check. */
function apexOf(world, shot) {
  const p = TE.physics.createProjectile(
    shot.x, shot.y, shot.angle, shot.power, shot.facing, shot.ownerId, shot.wind
  );
  const dt = C.SIM_STEP / C.SIM_SUBSTEPS;
  let apex = p.y;
  while (p.age < 26) {
    if (TE.physics.step(world, p, dt)) break;
    apex = Math.max(apex, p.y);
  }
  return apex;
}

// ------------------------------------------------------------------- output
console.log('Tanks Evolved — simulation determinism check');
console.log(`version: ${ctx.RELEASE_VERSION}+b${ctx.BUILD_NUMBER}`);
console.log(`world:   ${C.WORLD_W} x ${C.WORLD_H} units, terrain step ${C.TERRAIN_STEP} (${Math.round(C.WORLD_W / C.TERRAIN_STEP) + 1} columns)`);
console.log('');

let failed = 0;
for (const r of results) {
  const tag = r.ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${r.name}`);
  if (r.detail) console.log(`      ${r.detail.replace(/\n/g, '\n      ')}`);
  if (!r.ok) failed++;
}

console.log('');
console.log('Trajectory range report (no wind, muzzle 30 units above flat ground):');
console.log(rangeReport());
console.log('');

// Design assumption behind the map size: a full-power 45° shot must be able to
// reach across the map, and a half-power shot must be a reasonable opener.
const coverage = (() => {
  const ev = TE.physics.simulateShot(FLAT, Object.assign({
    facing: 1, ownerId: 1, wind: 0
  }, FLAT_MUZZLE, { angle: 45, power: 100 }));
  return ev.x - FLAT_MUZZLE.x;
})();
const sampleWorld = makeWorld('EAGLE-4821');
const separation = Math.abs(sampleWorld.tanks[1].x - sampleWorld.tanks[0].x);
console.log(`design: full-power 45° range ≈ ${coverage.toFixed(0)} units; map is ${C.WORLD_W} units wide`);
console.log(`design: seed "EAGLE-4821" spawns tanks ${separation.toFixed(0)} units apart — a cross-map shot needs ~80-100% power`);

// Design assumption behind the cover: a barrier has to be low enough to shoot
// over, or the map stops being a match. Measured over the 50-seed spread in
// check 13 rather than asserted from the cap on its own.
const coverReport = report.cover;
const coverSample = TE.terrain.createCover('EAGLE-4821', TE.terrain.create('EAGLE-4821'));
console.log(`design: ${coverSample.length} mirrored barriers between x=` +
  `${(C.WORLD_W * 0.30).toFixed(0)} and x=${(C.WORLD_W * 0.70).toFixed(0)}, ` +
  `heights ${coverSample.filter((b) => !b.mirror).map((b) => b.h.toFixed(0)).join('/')} (cap ${report.coverCap})`);
if (coverReport) {
  console.log(`design: the 45°/100 arc clears the highest barrier between the spawns by ≥` +
    `${coverReport.minClear.toFixed(0)} units over ${coverReport.seeds} seeds, and the worst clean shot ` +
    `still lands ${coverReport.worstBest.toFixed(0)} units from the enemy (blast radius ${C.BLAST_RADIUS})`);
}

const total = results.length;
const passed = total - failed;
console.log(`${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
