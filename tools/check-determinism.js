#!/usr/bin/env node
/**
 * tools/check-determinism.js — Node-side verification of the simulation core.
 *
 * Loads js/version.js, utils.js, terrain.js, tanks.js and physics.js into a
 * single `vm` context (exactly the globals a browser `<script>` tag would
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
 * Usage:  node tools/check-determinism.js
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */
'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const MODULES = ['version.js', 'utils.js', 'terrain.js', 'tanks.js', 'physics.js'];

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

// ---------------------------------------------------------------- test runner
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
    tanks: [TE.tank.create(1, x1, terrain), TE.tank.create(2, x2, terrain)],
    wind: 0
  };
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

// ------------------------------------------------- terrain / range report
/** A perfectly flat test terrain, so ranges are comparable across powers. */
function flatWorld(groundY) {
  const cols = Math.round(C.WORLD_W / C.TERRAIN_STEP) + 1;
  const heights = new Float64Array(cols).fill(groundY);
  return {
    seed: 'flat',
    terrain: { seed: 'flat', step: C.TERRAIN_STEP, cols, width: (cols - 1) * C.TERRAIN_STEP, heights },
    tanks: [],
    wind: 0
  };
}

/** Muzzle 30 units above flat ground — the reference condition for the table. */
const FLAT = flatWorld(200);
const FLAT_MUZZLE = { x: 100, y: 230 };

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

const total = results.length;
const passed = total - failed;
console.log(`${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
