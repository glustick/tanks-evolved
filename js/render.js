/**
 * render.js — Canvas 2D presentation: ash-and-dust post-apocalyptic scene,
 * shell-following camera, particle FX and the in-canvas HUD.
 *
 * Everything in this file is cosmetic. Nothing here may feed back into game
 * state, which is what lets the simulation stay deterministic while the eye
 * candy is allowed to depend on frame timing.
 *
 * That rule is why the scenery draws from `derive(seed, 'scenery')` and from one
 * fixed, seed-independent stream, and from nothing else: `terrain`, `spawn`,
 * `wind` and `ridge` feed the simulation, and drawing a *new* number of values
 * out of any of them would shift what that stream produces for every existing
 * seed — a different battlefield, an invalidated tuning table and every stored
 * replay broken, for a change that is meant to be invisible to the physics.
 * A new stream cannot do that, and neither can a stream the simulation never
 * reads (the old `ridge` silhouettes were only ever scenery).
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});
  var C = TE.CONST;
  var U = TE.utils;

  // Ash, dust and a low burnt-orange horizon. The two player accents are left
  // alone: they are identity colours the stylesheet shares, and a teal/amber
  // pair is the one thing in this palette that must not drift.
  var COLORS = {
    skyTop: '#0a0908',       // ash-black overhead
    skyMid: '#241a14',       // dust brown, most of the sky
    skyLow: '#63351a',       // burnt orange, low on the horizon
    horizon: 'rgba(255,138,52,0.30)', // glow band sitting on the horizon
    sun: 'rgba(255,170,92,0.5)',      // the dust-dimmed sun behind the ruins
    ruinFar: '#2c2521',      // distant skyline, washed out by dust
    ruinNear: '#1b1614',     // the nearer one, nearly black
    ruinEdge: 'rgba(255,150,80,0.18)', // rim light along a broken roofline
    haze: 'rgba(214,160,110,0.10)',    // dust veil between the two layers
    groundTop: '#342a20',    // scorched earth under a layer of ash
    groundDeep: '#0b0908',
    crust: '#8a6f4e',        // dry lit surface
    crustGlow: 'rgba(255,164,88,0.40)',
    p1: '#3fe0c4',
    p1Dark: '#0d5148',
    p2: '#ffb057',
    p2Dark: '#5c370f',
    shell: '#fff8e7',
    trailOld: '#8a6f52',
    trailLive: '#ffd9a0',
    wreck: '#2a251f',
    deadWood: '#1c1613',     // dead trees, poles and hulls on the ground line
    ash: '#cdad86',          // airborne ash
    // Solid cover: lit from the low sun, so it reads as an object standing in the
    // battlefield rather than as more silhouette. Nothing else on the field is
    // drawn this way, which is what keeps a barrier distinguishable from scenery.
    blockTop: '#77664f',
    blockMid: '#4a3d31',
    blockDeep: '#221b16',
    blockEdge: 'rgba(255,206,148,0.8)',
    blockSeam: 'rgba(0,0,0,0.45)',
    blockOutline: 'rgba(8,6,5,0.85)',
    blockGrit: 'rgba(255,214,166,0.35)',
    blockFoot: 'rgba(48,40,32,0.7)'
  };

  var MAX_PARTICLES = 900;

  // How far below the ground line a backdrop shape is drawn. The terrain is
  // opaque from its surface down, so anything under this is hidden and the exact
  // value does not matter — it only has to be more than the deepest valley.
  var SKYLINE_FOOT = 900;

  // --------------------------------------------------------------- lifecycle
  function create(canvas) {
    var r = {
      canvas: canvas,
      ctx: canvas.getContext('2d'),
      w: 960, h: 540, dpr: 1,
      cam: { x: C.WORLD_W / 2, y: C.WORLD_H / 2, zoom: 1 },
      particles: [],
      floaters: [],
      scorch: [],
      embers: [],
      skyline: [],
      rubble: [],
      motes: [],
      sun: { t: 0.5, y: 168 },
      streaks: [],
      sprites: {},
      // Visual-only RNG. Deliberately separate from the match seed: FX may be
      // frame-rate dependent, the simulation never is.
      fxRng: TE.rng.fromSeed('fx-visual'),
      time: 0,
      shake: 0,
      wreckSmokeT: 0,
      skyGrad: null,
      terrainGrad: null,
      groundRef: null
    };
    buildEmbers(r);
    resize(r);
    return r;
  }

  /** Recompute canvas size in CSS pixels and apply the device pixel ratio. */
  function resize(r) {
    var rect = r.canvas.getBoundingClientRect ? r.canvas.getBoundingClientRect() : null;
    var cssW = (rect && rect.width) || r.canvas.clientWidth || 960;
    var cssH = (rect && rect.height) || r.canvas.clientHeight || 540;
    var dpr = U.clamp(root.devicePixelRatio || 1, 1, 2);

    r.w = Math.max(320, Math.round(cssW));
    r.h = Math.max(200, Math.round(cssH));
    r.dpr = dpr;
    r.canvas.width = Math.round(r.w * dpr);
    r.canvas.height = Math.round(r.h * dpr);
    if (r.ctx.setTransform) r.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    r.skyGrad = null;
    r.terrainGrad = null;
    return r;
  }

  /**
   * Ash hanging in the upper air. Fixed stream, like the star field it replaces:
   * one shape of sky for every seed, and nothing here depends on the match.
   */
  function buildEmbers(r) {
    var rng = TE.rng.fromSeed('tanks-evolved-ash');
    r.embers = [];
    for (var i = 0; i < 120; i++) {
      r.embers.push({
        x: rng.next(),
        y: rng.next() * 0.6,
        size: rng.range(0.7, 1.9),
        alpha: rng.range(0.10, 0.42),
        phase: rng.range(0, Math.PI * 2)
      });
    }
  }

  /**
   * Regenerate every seed-dependent piece of scenery for a new match: the ruined
   * skyline where the ridges were, the dead trees and wreckage along the ground
   * line, the drifting ash, and the sun.
   *
   * Heights are stored *relative to the ground line* (see groundLineOf) rather
   * than as world elevations. A fixed world elevation does not work here: the
   * ground is drawn as an opaque mass from its surface down, and the surface
   * moves between 120 and 440, so a backdrop pinned to an elevation is either
   * buried behind a hill or left floating in the sky over a valley. Anchoring it
   * to the highest ground in view is what keeps the ruins standing behind the
   * ridge instead of inside it.
   *
   * One stream for all of it — nothing here is read by the simulation, so a new
   * number of draws from it cannot move a tank or a shell for any seed.
   */
  function setSeed(r, seed) {
    var rng = TE.rng.derive(seed, 'scenery');
    r.sun = { t: rng.range(0.10, 0.45), rise: rng.range(120, 210) };
    buildSkyline(r, rng);
    buildRubble(r, rng);
    buildMotes(r, rng);
    // Wind streaks: thin horizontal dust lines that drift with the wind.
    r.streaks = [];
    for (var s = 0; s < 26; s++) {
      r.streaks.push({
        x: rng.range(0, C.WORLD_W),
        y: rng.range(30, 420),
        len: rng.range(10, 34),
        speed: rng.range(0.4, 1.1),
        alpha: rng.range(0.05, 0.18)
      });
    }
    return r;
  }

  /**
   * Two parallax layers of ruined skyline: distant towers behind, broken low
   * blocks in front, which is the usual deep-to-near taper of a skyline seen
   * across a valley.
   *
   * Each layer is a walk across the world width laying down broken blocks: a gap,
   * then a structure of seeded width and height with one ragged notch in the roof
   * when the stream says so. Points are emitted in strictly increasing t — a
   * silhouette that doubles back would fill as a bow tie — and each block
   * contributes two vertical walls down to well below the ground line, so a
   * block is a rectangle standing behind the terrain and only its top shows.
   */
  function buildSkyline(r, rng) {
    var layers = [
      { roofLo: 44, roofHi: 150, parallax: 0.30, color: COLORS.ruinFar, alpha: 0.82 },
      { roofLo: 12, roofHi: 96, parallax: 0.52, color: COLORS.ruinNear, alpha: 1 }
    ];
    var foot = -SKYLINE_FOOT;
    r.skyline = [];
    for (var l = 0; l < layers.length; l++) {
      var cfg = layers[l];
      var points = [];
      var t = rng.range(0, 0.03);
      while (t < 1) {
        t += rng.range(0.012, 0.07);              // gap between structures
        if (t >= 1) break;
        var width = rng.range(0.014, 0.048);
        // Squared draw: most roofs sit low, a few towers still stand.
        var top = cfg.roofLo + Math.pow(rng.next(), 1.7) * (cfg.roofHi - cfg.roofLo);
        points.push({ t: t, y: foot });
        points.push({ t: t, y: top });
        if (rng.next() < 0.6) {
          points.push({ t: t + width * rng.range(0.30, 0.55), y: top - rng.range(6, 24) });
        }
        points.push({ t: t + width, y: top - rng.range(0, 9) });
        points.push({ t: t + width, y: foot });
        t += width;
      }
      if (points.length < 4) points.push({ t: 1, y: foot });
      r.skyline.push({ points: points, parallax: cfg.parallax, color: cfg.color, alpha: cfg.alpha });
    }
  }

  /**
   * Dead trees, leaning poles and burnt-out hulls standing in front of the
   * rubble line. Their trunks run far below it so the terrain covers the excess
   * wherever the local ground is lower than the highest ground in view.
   */
  function buildRubble(r, rng) {
    r.rubble = [];
    var kinds = ['tree', 'tree', 'tree', 'pole', 'wreck', 'wreck'];
    for (var i = 0; i < 26; i++) {
      r.rubble.push({
        t: rng.next(),
        kind: rng.pick(kinds),
        h: rng.range(18, 74),
        w: rng.range(9, 24),
        lean: rng.range(-0.22, 0.22),
        drop: rng.range(0, 40)
      });
    }
  }

  /** Airborne ash: specks that drift with the wind and settle slowly. */
  function buildMotes(r, rng) {
    r.motes = [];
    for (var i = 0; i < 70; i++) {
      r.motes.push({
        x: rng.range(0, C.WORLD_W),
        y: rng.range(30, 470),
        size: rng.range(0.8, 2.2),
        alpha: rng.range(0.05, 0.18),
        fall: rng.range(3, 11),
        bob: rng.range(0, Math.PI * 2)
      });
    }
  }

  // ------------------------------------------------------------ coordinates
  function worldToScreen(r, x, y) {
    return {
      x: (x - r.cam.x) * r.cam.zoom + r.w * 0.5,
      y: (r.cam.y - y) * r.cam.zoom + r.h * 0.5
    };
  }

  function screenToWorld(r, sx, sy) {
    return {
      x: (sx - r.w * 0.5) / r.cam.zoom + r.cam.x,
      y: (r.h * 0.5 - sy) / r.cam.zoom + r.cam.y
    };
  }

  /**
   * Shell-following, world-clamped camera.
   *
   * While aiming, the view is framed so both tanks are visible — you must be
   * able to see your target to judge the shot. While a shell is in the air the
   * camera follows it and zooms out so the whole arc stays legible.
   */
  function updateCamera(r, world, dt) {
    var flying = world.state === 'flying' && world.shell;
    var target, targetZoom;

    if (flying) {
      target = { x: world.shell.x + world.shell.vx * 0.16, y: world.shell.y + world.shell.vy * 0.16 };
      targetZoom = U.clamp(r.h / 900, 0.26, 1.7);
    } else {
      var active = world.tanks[world.activeIndex];
      var other = world.tanks[1 - world.activeIndex];
      // Frame both tanks, with room above them for the arc.
      var padX = 140;
      var minX = Math.min(active.x, other.x) - padX;
      var maxX = Math.max(active.x, other.x) + padX;
      var groundY = Math.max(active.y, other.y);
      target = { x: (minX + maxX) * 0.5, y: groundY + 80 };
      // The floor is low enough that a phone-width window can still frame the
      // whole battlefield instead of clipping one tank off the edge.
      targetZoom = U.clamp(Math.min(r.w / (maxX - minX), r.h / 700), 0.22, 1.35);
    }

    var cam = r.cam;
    var rate = flying ? 5.5 : 3.4;
    cam.zoom = U.damp(cam.zoom, targetZoom, rate, dt);
    cam.x = U.damp(cam.x, target.x, rate, dt);
    cam.y = U.damp(cam.y, target.y, rate, dt);

    // Keep the view inside the world when it is narrower than the world.
    var halfW = (r.w * 0.5) / cam.zoom;
    var halfH = (r.h * 0.5) / cam.zoom;
    cam.x = halfW * 2 >= C.WORLD_W ? C.WORLD_W / 2 : U.clamp(cam.x, halfW, C.WORLD_W - halfW);
    var loY = halfH - 40;
    var hiY = C.WORLD_H + 120 - halfH;
    cam.y = loY >= hiY ? C.WORLD_H / 2 : U.clamp(cam.y, loY, hiY);

    // The backdrop stands behind the highest ground in view, so follow that with
    // the camera rather than jumping to it — a hill sliding into frame would
    // otherwise make the whole skyline hop.
    var ground = groundLineOf(r, world);
    r.groundRef = U.damp(r.groundRef == null ? ground : r.groundRef, ground, 4, dt);
    return cam;
  }

  /**
   * Highest ground in view, in world units — the line the scenery stands behind.
   *
   * The ground is drawn as an opaque mass, so a backdrop element is visible
   * exactly where it rises above the local surface. Anchoring the scenery to the
   * highest surface on screen means the ruined skyline always has something to
   * stand behind and never floats over a valley.
   */
  function groundLineOf(r, world) {
    if (!world || !world.terrain) return C.GROUND_MAX;
    var halfW = (r.w * 0.5) / r.cam.zoom;
    var lo = Math.max(0, r.cam.x - halfW);
    var hi = Math.min(C.WORLD_W, r.cam.x + halfW);
    var step = Math.max(6, (hi - lo) / 24);
    var peak = C.GROUND_MIN;
    for (var x = lo; x <= hi; x += step) {
      var h = TE.terrain.heightAt(world.terrain, x);
      if (h > peak) peak = h;
    }
    return peak;
  }

  // ---------------------------------------------------------------- FX input
  /** Screen shake. Called by game.js on explosions. */
  function addShake(r, amount) {
    r.shake = Math.min(28, r.shake + amount);
  }

  /** Record a permanent scorch mark (drawn under everything else). */
  function addScorch(r, x, y, radius) {
    r.scorch.push({ x: x, y: y, radius: radius });
    if (r.scorch.length > 60) r.scorch.shift();
  }

  function pushFloater(r, text, x, y, color) {
    r.floaters.push({ text: text, x: x, y: y, color: color, life: 0, maxLife: 1.5 });
    if (r.floaters.length > 12) r.floaters.shift();
  }

  function spawnParticle(r, p) {
    if (r.particles.length >= MAX_PARTICLES) return;
    r.particles.push(p);
  }

  /** Muzzle flash: a short-lived cone of sparks at the barrel tip. */
  function addMuzzleFlash(r, x, y, angleDeg, facing) {
    var rng = r.fxRng;
    var base = Math.atan2(Math.sin(U.toRad(angleDeg)), Math.cos(U.toRad(angleDeg)) * facing);
    for (var i = 0; i < 12; i++) {
      var a = base + rng.range(-0.32, 0.32);
      var speed = rng.range(90, 260);
      spawnParticle(r, {
        type: 'spark',
        x: x, y: y,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        life: 0, maxLife: rng.range(0.14, 0.34),
        size: rng.range(1.2, 2.6), color: rng.next() < 0.5 ? '#ffd9a0' : '#fff3d0'
      });
    }
    for (i = 0; i < 5; i++) {
      spawnParticle(r, {
        type: 'smoke',
        x: x + rng.range(-4, 4), y: y + rng.range(-4, 4),
        vx: Math.cos(base) * rng.range(30, 70) * facing, vy: rng.range(8, 30),
        life: 0, maxLife: rng.range(0.5, 1.1),
        size: rng.range(4, 9), color: 'rgba(206,186,160,0.5)'
      });
    }
  }

  /**
   * A shell breaking on a barrier: sparks off the face and a little dust, but no
   * crater and no scorch — nothing here was destroyed, and a wall that left a mark
   * in the ground would be read as damage the simulation is not applying.
   */
  function addSparks(r, x, y, speed) {
    var rng = r.fxRng;
    var s = U.clamp((speed || 400) / 900, 0.4, 1.2);
    for (var i = 0; i < 14; i++) {
      var a = rng.range(-Math.PI, 0); // sparks come off upward: the shell hit a wall
      var sp = rng.range(70, 300) * s;
      spawnParticle(r, {
        type: 'spark',
        x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0, maxLife: rng.range(0.18, 0.5),
        size: rng.range(1, 2.2), color: rng.next() < 0.5 ? '#ffd9a0' : '#fff6e0'
      });
    }
    for (i = 0; i < 6; i++) {
      spawnParticle(r, {
        type: 'smoke',
        x: x + rng.range(-6, 6), y: y + rng.range(-4, 6),
        vx: rng.range(-26, 26), vy: rng.range(10, 40),
        life: 0, maxLife: rng.range(0.6, 1.4),
        size: rng.range(5, 11), color: 'rgba(186,168,148,0.4)'
      });
    }
  }

  /** Explosion at an impact point: shock ring, dirt, smoke and sparks. */
  function addExplosion(r, x, y, radius, strength) {
    var rng = r.fxRng;
    var s = strength == null ? 1 : strength;
    spawnParticle(r, {
      type: 'ring', x: x, y: y, vx: 0, vy: 0,
      life: 0, maxLife: 0.45, size: radius * 0.28 * s, color: 'rgba(255,220,170,0.9)'
    });
    spawnParticle(r, {
      type: 'flash', x: x, y: y, vx: 0, vy: 0,
      life: 0, maxLife: 0.18, size: radius * 0.5 * s, color: 'rgba(255,240,214,0.95)'
    });
    var i;
    for (i = 0; i < 22; i++) {
      var a = rng.range(0, Math.PI * 2);
      var sp = rng.range(60, 300) * s;
      spawnParticle(r, {
        type: 'dirt',
        x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.abs(Math.sin(a)) * sp * 1.15,
        life: 0, maxLife: rng.range(0.7, 1.6),
        size: rng.range(1.5, 4.2), color: rng.next() < 0.4 ? '#4a3d2d' : '#2a231b'
      });
    }
    for (i = 0; i < 14; i++) {
      spawnParticle(r, {
        type: 'smoke',
        x: x + rng.range(-10, 10), y: y + rng.range(-6, 10),
        vx: rng.range(-40, 40), vy: rng.range(20, 90),
        life: 0, maxLife: rng.range(0.9, 2.2),
        size: rng.range(8, 20), color: 'rgba(178,160,140,0.42)'
      });
    }
    for (i = 0; i < 26; i++) {
      var a2 = rng.range(0, Math.PI * 2);
      var sp2 = rng.range(140, 520) * s;
      spawnParticle(r, {
        type: 'spark',
        x: x, y: y,
        vx: Math.cos(a2) * sp2, vy: Math.sin(a2) * sp2,
        life: 0, maxLife: rng.range(0.2, 0.55),
        size: rng.range(1, 2.4), color: rng.next() < 0.5 ? '#ffcf87' : '#fff0c8'
      });
    }
  }

  /** Advance every visual effect. Never touches game state. */
  function updateFx(r, world, dt) {
    r.time += dt;
    r.shake = Math.max(0, r.shake - dt * 32);

    var alive = [];
    for (var i = 0; i < r.particles.length; i++) {
      var p = r.particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) continue;

      if (p.type === 'dirt') {
        p.vy -= C.GRAVITY * 0.55 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (world && world.terrain && p.y < TE.terrain.heightAt(world.terrain, p.x)) continue;
      } else if (p.type === 'spark') {
        p.vy -= C.GRAVITY * 0.35 * dt;
        p.vx *= 1 - 1.6 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      } else if (p.type === 'smoke') {
        p.vy += 26 * dt;
        p.vx += (world ? world.wind * 26 : 0) * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      } else if (p.type === 'ring') {
        p.size += 190 * dt;
      } else if (p.type === 'flash') {
        p.size += 60 * dt;
      }
      alive.push(p);
    }
    r.particles = alive;

    var keep = [];
    for (i = 0; i < r.floaters.length; i++) {
      var f = r.floaters[i];
      f.life += dt;
      f.y += 26 * dt;
      if (f.life < f.maxLife) keep.push(f);
    }
    r.floaters = keep;

    // Wrecked tanks smoke continuously.
    r.wreckSmokeT -= dt;
    if (world && r.wreckSmokeT <= 0) {
      r.wreckSmokeT = 0.22;
      for (i = 0; i < world.tanks.length; i++) {
        var t = world.tanks[i];
        if (t.alive) continue;
        var c = TE.tank.bodyCenter(t);
        spawnParticle(r, {
          type: 'smoke',
          x: c.x + r.fxRng.range(-4, 4), y: c.y + 6,
          vx: r.fxRng.range(-12, 12), vy: r.fxRng.range(18, 40),
          life: 0, maxLife: r.fxRng.range(1.2, 2.4),
          size: r.fxRng.range(5, 11), color: 'rgba(140,132,122,0.4)'
        });
      }
    }

    // Wind streaks drift forever, wrapping around the map.
    if (world) {
      for (i = 0; i < r.streaks.length; i++) {
        var sk = r.streaks[i];
        sk.x += world.wind * 42 * sk.speed * dt;
        if (sk.x > C.WORLD_W + 60) sk.x -= C.WORLD_W + 120;
        if (sk.x < -60) sk.x += C.WORLD_W + 120;
      }
    }

    // Airborne ash: carried sideways by the wind, settling the whole time.
    // Position is world-space, so the specks belong to the battlefield rather
    // than to the viewport — they are the one part of the backdrop a camera pan
    // moves at the same rate as the ground.
    for (i = 0; i < r.motes.length; i++) {
      var m = r.motes[i];
      m.x += (14 + (world ? world.wind * 34 : 0)) * dt;
      m.y -= m.fall * dt;
      if (m.y < 20) { m.y = 470; m.x = (m.x + 640) % C.WORLD_W; }
      if (m.x > C.WORLD_W) m.x -= C.WORLD_W;
    }
  }

  // ----------------------------------------------------------------- drawing
  function draw(r, world) {
    var ctx = r.ctx;
    var shakeX = r.shake > 0 ? Math.sin(r.time * 61) * r.shake : 0;
    var shakeY = r.shake > 0 ? Math.cos(r.time * 53) * r.shake * 0.6 : 0;

    ctx.save();
    ctx.clearRect(0, 0, r.w, r.h);
    ctx.translate(shakeX, shakeY);
    // The scenery is positioned against the ground line, so it is resolved once
    // for the whole frame: whichever part is drawn, it stands behind the same
    // ridge. updateCamera damps it; a direct draw() call still gets a value.
    var ground = r.groundRef == null ? groundLineOf(r, world) : r.groundRef;
    drawSky(r, world, ground);
    drawSkyline(r, ground);
    drawRubble(r, ground);
    drawWindStreaks(r, world);
    drawMotes(r);
    drawTerrain(r, world);
    drawCover(r, world);
    drawTrails(r, world);
    drawTanks(r, world);
    drawShell(r, world);
    drawParticles(r);
    drawAimGuide(r, world);
    drawFloaters(r);
    ctx.restore();
  }

  /** Screen y of a world elevation. */
  function screenYOf(r, worldY) {
    return (r.cam.y - worldY) * r.cam.zoom + r.h * 0.5;
  }

  function drawSky(r, world, ground) {
    var ctx = r.ctx;
    if (!r.skyGrad) {
      var g = ctx.createLinearGradient(0, 0, 0, r.h);
      g.addColorStop(0, COLORS.skyTop);
      g.addColorStop(0.55, COLORS.skyMid);
      g.addColorStop(1, COLORS.skyLow);
      r.skyGrad = g;
    }
    ctx.fillStyle = r.skyGrad;
    ctx.fillRect(0, 0, r.w, r.h);

    var horizon = screenYOf(r, ground);

    // The burnt-orange band sitting on the horizon. Rebuilt every frame because
    // it tracks the camera; one gradient is nothing next to the particle count.
    var band = ctx.createLinearGradient(0, horizon - r.h * 0.55, 0, horizon + 40);
    band.addColorStop(0, 'rgba(255,138,52,0)');
    band.addColorStop(0.75, COLORS.horizon);
    band.addColorStop(1, 'rgba(255,170,90,0.06)');
    ctx.fillStyle = band;
    ctx.fillRect(0, horizon - r.h * 0.55, r.w, r.h * 0.55 + 40);

    drawSun(r, ground);

    // Ash in the upper air, drifting slowly sideways with the camera.
    for (var i = 0; i < r.embers.length; i++) {
      var e = r.embers[i];
      var sx = (e.x * C.WORLD_W - r.cam.x * 0.08 + r.time * 4) * r.cam.zoom + r.w * 0.5;
      sx = ((sx % r.w) + r.w) % r.w;
      var sy = e.y * r.h * 0.6 - (r.cam.y - C.WORLD_H / 2) * 0.05;
      if (sy > horizon) continue; // below the ground line is the ground's business
      ctx.globalAlpha = e.alpha * (0.7 + 0.3 * Math.sin(r.time * 0.9 + e.phase));
      ctx.fillStyle = COLORS.ash;
      ctx.fillRect(sx, sy, e.size, e.size);
    }
    ctx.globalAlpha = 1;
  }

  /** A dust-dimmed sun, low and behind the ruins. */
  function drawSun(r, ground) {
    var ctx = r.ctx;
    var sun = r.sun;
    var cx = ((sun.t * C.WORLD_W) - r.cam.x * 0.15) * r.cam.zoom + r.w * 0.5;
    var cy = screenYOf(r, ground + sun.rise);
    var radius = Math.max(28, 96 * r.cam.zoom);
    if (cx < -radius || cx > r.w + radius) return;
    var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0, COLORS.sun);
    grad.addColorStop(0.42, 'rgba(255,150,70,0.16)');
    grad.addColorStop(1, 'rgba(255,140,60,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Ruined skyline, tiled in camera space so the range keeps covering the
   * viewport however far the camera pans. A dust veil goes over the far layer
   * before the near one is drawn, which is what separates them.
   */
  function drawSkyline(r, ground) {
    var ctx = r.ctx;
    var bottom = r.h + 40;
    for (var l = 0; l < r.skyline.length; l++) {
      var layer = r.skyline[l];
      var n = layer.points.length;
      var zoom = r.cam.zoom;
      var spanPx = C.WORLD_W * zoom;
      var anchor = r.cam.x * layer.parallax;
      var firstTile = Math.floor((anchor - (r.w * 0.5 + 120) / zoom) / C.WORLD_W) - 1;
      var lastTile = Math.ceil((anchor + (r.w * 0.5 + 120) / zoom) / C.WORLD_W) + 1;

      ctx.beginPath();
      ctx.moveTo((firstTile + 0) * spanPx - anchor * zoom + r.w * 0.5, bottom);
      for (var t = firstTile; t <= lastTile; t++) {
        for (var i = 0; i < n; i++) {
          var pt = layer.points[i];
          var sx = ((t + pt.t) * C.WORLD_W - anchor) * zoom + r.w * 0.5;
          var sy = screenYOf(r, ground + pt.y);
          ctx.lineTo(sx, sy);
        }
      }
      ctx.lineTo(((lastTile + 1) * C.WORLD_W - anchor) * zoom + r.w * 0.5, bottom);
      ctx.closePath();
      ctx.globalAlpha = layer.alpha;
      ctx.fillStyle = layer.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      // A thin lit edge along the broken roofline.
      ctx.strokeStyle = l === 0 ? 'rgba(255,150,80,0.10)' : COLORS.ruinEdge;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Dust between the layers, so the far skyline sits behind something. It
      // fades out above the rooflines instead of washing the sky flat.
      if (l === 0) {
        var top = screenYOf(r, ground + 190);
        var veil = ctx.createLinearGradient(0, top - r.h * 0.18, 0, top + r.h * 0.5);
        veil.addColorStop(0, 'rgba(214,160,110,0)');
        veil.addColorStop(0.5, COLORS.haze);
        veil.addColorStop(1, 'rgba(214,160,110,0)');
        ctx.fillStyle = veil;
        ctx.fillRect(0, top - r.h * 0.18, r.w, r.h * 0.68);
      }
    }
  }

  /**
   * Dead trees, poles and burnt-out hulls standing in front of the near skyline
   * and still behind the heightfield, so the ground covers their feet wherever
   * the terrain is high. Their trunks run on down past the ground line for the
   * same reason: what is under the surface is never seen.
   */
  function drawRubble(r, ground) {
    var ctx = r.ctx;
    var zoom = r.cam.zoom;
    var anchor = r.cam.x * 0.78;
    var firstTile = Math.floor((anchor - (r.w * 0.5 + 120) / zoom) / C.WORLD_W) - 1;
    var lastTile = Math.ceil((anchor + (r.w * 0.5 + 120) / zoom) / C.WORLD_W) + 1;

    ctx.save();
    ctx.globalAlpha = 0.94;
    ctx.strokeStyle = COLORS.deadWood;
    ctx.fillStyle = COLORS.deadWood;
    ctx.lineCap = 'round';

    for (var t = firstTile; t <= lastTile; t++) {
      for (var i = 0; i < r.rubble.length; i++) {
        var p = r.rubble[i];
        var sx = ((t + p.t) * C.WORLD_W - anchor) * zoom + r.w * 0.5;
        if (sx < -60 || sx > r.w + 60) continue;
        var foot = screenYOf(r, ground - p.drop);
        var len = (p.h + p.drop) * zoom;
        ctx.save();
        ctx.translate(sx, foot);
        if (p.kind === 'tree') drawDeadTree(ctx, p, len, zoom);
        else if (p.kind === 'pole') drawDeadPole(ctx, p, len, zoom);
        else drawHull(ctx, p, len, zoom);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  /**
   * A trunk with bare branches: no leaves, and never quite upright. Drawn
   * downward past the ground line as well, so where the surrounding ground sits
   * lower than the line the tree still reaches into it rather than floating.
   */
  function drawDeadTree(ctx, p, len, zoom) {
    var lean = p.lean;
    ctx.lineWidth = Math.max(1, 2.2 * zoom);
    ctx.beginPath();
    ctx.moveTo(0, SKYLINE_FOOT * zoom);
    ctx.lineTo(lean * len, -len);
    ctx.stroke();
    ctx.lineWidth = Math.max(0.8, 1.3 * zoom);
    for (var b = 0; b < 4; b++) {
      var at = 0.45 + b * 0.14;
      var bx = lean * len * at;
      var by = -len * at;
      var side = b % 2 === 0 ? 1 : -1;
      var arm = Math.max(5, len * (0.34 - b * 0.04));
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + side * arm, by - arm * 0.9);
      ctx.stroke();
    }
  }

  /** A leaning post with one crossbar left on it. */
  function drawDeadPole(ctx, p, len, zoom) {
    var lean = p.lean;
    ctx.lineWidth = Math.max(1, 2 * zoom);
    ctx.beginPath();
    ctx.moveTo(0, SKYLINE_FOOT * zoom);
    ctx.lineTo(lean * len * 0.7, -len * 0.7);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, 1.6 * zoom);
    ctx.beginPath();
    ctx.moveTo(lean * len * 0.5 - p.w * 0.3 * zoom, -len * 0.55);
    ctx.lineTo(lean * len * 0.5 + p.w * 0.3 * zoom, -len * 0.62);
    ctx.stroke();
  }

  /** A burnt-out hull, canted over and missing its turret. */
  function drawHull(ctx, p, len, zoom) {
    ctx.save();
    ctx.rotate(p.lean);
    var w = Math.max(6, p.w * zoom);
    var bh = Math.max(5, len * 0.5);
    roundRect(ctx, -w / 2, -bh, w, bh, Math.min(3, bh / 2));
    ctx.fill();
    // The stump of a mounting, which is what makes it read as a wreck.
    roundRect(ctx, -w * 0.18, -bh - bh * 0.28, w * 0.36, bh * 0.3, Math.min(2, bh * 0.12));
    ctx.fill();
    ctx.restore();
  }

  /** Ash specks in the play space, drawn behind the ground. */
  function drawMotes(r) {
    var ctx = r.ctx;
    ctx.fillStyle = COLORS.ash;
    for (var i = 0; i < r.motes.length; i++) {
      var m = r.motes[i];
      var p = worldToScreen(r, m.x, m.y);
      if (p.x < -10 || p.x > r.w + 10) continue;
      ctx.globalAlpha = m.alpha * (0.75 + 0.25 * Math.sin(r.time * 1.3 + m.bob));
      ctx.fillRect(p.x, p.y, m.size, m.size);
    }
    ctx.globalAlpha = 1;
  }

  function drawWindStreaks(r, world) {
    if (!world) return;
    var mag = Math.abs(world.wind);
    if (mag < 0.05) return;
    var ctx = r.ctx;
    var dir = world.wind > 0 ? 1 : -1;
    ctx.strokeStyle = 'rgb(226,186,146)';
    ctx.lineWidth = 1;
    for (var i = 0; i < r.streaks.length; i++) {
      var s = r.streaks[i];
      var p0 = worldToScreen(r, s.x, s.y);
      var len = s.len * (0.4 + mag) * r.cam.zoom * 0.6;
      ctx.globalAlpha = s.alpha * (0.35 + mag);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p0.x + len * dir, p0.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Solid cover, drawn exactly where the simulation tests it — the same rect, the
   * same footing read off the heightfield. A wall drawn a pixel away from the wall
   * a shell stops against is a bug the player sees before anybody else does, so
   * there is no separate idea of what a barrier looks like.
   *
   * It has to read as a *thing* rather than as more skyline: the ruin silhouettes
   * behind it are pillars of much the same proportions, and the difference has to
   * be unmistakable or the player cannot tell what stops a shell and what does not.
   * So unlike the scenery this is lit — concrete pale enough to separate from the
   * dark backdrop, a hard outline, a bright rim on top, and panel seams and rivets
   * that belong to no other object on the field.
   */
  function drawCover(r, world) {
    var blocks = world.cover;
    if (!blocks || !blocks.length) return;
    var ctx = r.ctx;
    var zoom = r.cam.zoom;
    var halfW = (r.w * 0.5) / zoom;

    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block.x + block.w < r.cam.x - halfW - 40 || block.x - block.w > r.cam.x + halfW + 40) continue;

      var rect = TE.terrain.coverRect(world.terrain, block);
      var x0 = worldToScreen(r, rect.x0, rect.y1).x;
      var y0 = worldToScreen(r, 0, rect.y1).y;
      var x1 = worldToScreen(r, rect.x1, 0).x;
      var y1 = worldToScreen(r, 0, rect.y0).y;
      var w = x1 - x0;
      var h = y1 - y0;

      ctx.save();
      var grad = ctx.createLinearGradient(0, y0, 0, y1);
      grad.addColorStop(0, COLORS.blockTop);
      grad.addColorStop(0.4, COLORS.blockMid);
      grad.addColorStop(1, COLORS.blockDeep);
      ctx.fillStyle = grad;
      ctx.fillRect(x0, y0, w, h);

      // Horizontal panel seams with a rivet at each end: a poured slab, not a
      // boulder, and the one shape on the field nothing else has.
      var seams = Math.max(1, Math.min(4, Math.round(h / (26 * zoom))));
      ctx.lineWidth = 1;
      for (var s = 1; s <= seams; s++) {
        var sy = Math.round(y0 + (h * s) / (seams + 1)) + 0.5;
        ctx.strokeStyle = COLORS.blockSeam;
        ctx.beginPath();
        ctx.moveTo(x0, sy);
        ctx.lineTo(x1, sy);
        ctx.stroke();
        if (w > 16) {
          ctx.fillStyle = COLORS.blockGrit;
          ctx.fillRect(x0 + w * 0.16, sy + 1, 1.4, 1.4);
          ctx.fillRect(x1 - w * 0.16 - 1.4, sy + 1, 1.4, 1.4);
        }
      }

      // A hard outline, so a wall in front of a dark ruin still has an edge.
      ctx.strokeStyle = COLORS.blockOutline;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);

      // Lit rim along the top and the upper part of the sunward edge; a low sun
      // is the only light there is.
      ctx.strokeStyle = COLORS.blockEdge;
      ctx.lineWidth = Math.max(1, 1.6 * zoom);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y0);
      ctx.stroke();
      if (w > 8) {
        ctx.strokeStyle = COLORS.blockGrit;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1 - 0.5, y0);
        ctx.lineTo(x1 - 0.5, y0 + h * 0.55);
        ctx.moveTo(x0 + 0.5, y0);
        ctx.lineTo(x0 + 0.5, y0 + h * 0.3);
        ctx.stroke();
      }

      // Ash banked against the foot, so the wall sits in the ground rather than
      // on top of it. Clipped to the block's own column, so it never spills.
      ctx.beginPath();
      ctx.rect(x0 - 1, y0, w + 2, h + 1);
      ctx.clip();
      ctx.fillStyle = COLORS.blockFoot;
      ctx.beginPath();
      ctx.ellipse((x0 + x1) * 0.5, y1 - 1, w * 0.85, Math.max(2, 7 * zoom), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawTerrain(r, world) {
    var ctx = r.ctx;
    var terrain = world.terrain;
    var step = terrain.step;
    var halfW = (r.w * 0.5) / r.cam.zoom;
    var viewLeft = r.cam.x - halfW;
    var viewRight = r.cam.x + halfW;
    var i0 = Math.max(0, Math.floor(Math.max(0, viewLeft) / step) - 1);
    var i1 = Math.min(terrain.cols - 1, Math.ceil(Math.min(terrain.width, viewRight) / step) + 1);
    var bottom = r.h + 60;
    var edgeLeft = terrain.heights[0];
    var edgeRight = terrain.heights[terrain.cols - 1];
    // When the camera zooms out far enough that the world is narrower than the
    // viewport, the ground continues past both ends at the edge elevation — the
    // map runs off screen instead of showing a void.
    var overshoot = 6000;
    var farLeft = worldToScreen(r, viewLeft - overshoot, edgeLeft);
    var farRight = worldToScreen(r, viewRight + overshoot, edgeRight);

    /**
     * Walk the surface from far off-screen left to far off-screen right,
     * optionally displaced downward by `worldOffsetY` (used for strata bands).
     */
    function eachSurfacePoint(worldOffsetY, visit) {
      var dy = worldOffsetY * r.cam.zoom;
      visit(farLeft.x, farLeft.y + dy);
      var lp = worldToScreen(r, 0, edgeLeft - worldOffsetY);
      visit(lp.x, lp.y);
      for (var i = i0; i <= i1; i++) {
        var p = worldToScreen(r, i * step, terrain.heights[i] - worldOffsetY);
        visit(p.x, p.y);
      }
      var rp = worldToScreen(r, terrain.width, edgeRight - worldOffsetY);
      visit(rp.x, rp.y);
      visit(farRight.x, farRight.y + dy);
    }

    function surfacePath(worldOffsetY) {
      ctx.beginPath();
      eachSurfacePoint(worldOffsetY, function (x, y) { ctx.lineTo(x, y); });
    }

    // Filled ground mass.
    ctx.beginPath();
    ctx.moveTo(farLeft.x, bottom);
    eachSurfacePoint(0, function (x, y) { ctx.lineTo(x, y); });
    ctx.lineTo(farRight.x, bottom);
    ctx.closePath();

    if (!r.terrainGrad) {
      var g = ctx.createLinearGradient(0, 0, 0, r.h);
      g.addColorStop(0, COLORS.groundTop);
      g.addColorStop(0.45, '#1e1712');
      g.addColorStop(1, COLORS.groundDeep);
      r.terrainGrad = g;
    }
    ctx.fillStyle = r.terrainGrad;
    ctx.fill();

    // Inside the ground: scorch marks and a few strata bands, so the mass below
    // the surface reads as rock rather than flat pixels.
    ctx.save();
    ctx.clip();
    for (var s = 0; s < r.scorch.length; s++) {
      var mark = r.scorch[s];
      var c = worldToScreen(r, mark.x, mark.y);
      var rad = mark.radius * r.cam.zoom;
      var rg = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rad);
      rg.addColorStop(0, 'rgba(0,0,0,0.55)');
      rg.addColorStop(0.6, 'rgba(0,0,0,0.25)');
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(c.x, c.y, rad, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.lineWidth = 1;
    var strata = [
      { offset: 18, alpha: 0.16 },
      { offset: 46, alpha: 0.12 },
      { offset: 88, alpha: 0.09 },
      { offset: 148, alpha: 0.06 }
    ];
    for (s = 0; s < strata.length; s++) {
      surfacePath(strata[s].offset);
      ctx.strokeStyle = 'rgba(226,178,120,' + strata[s].alpha + ')';
      ctx.stroke();
    }
    ctx.restore();

    // Lit crust: a soft wide pass plus a crisp thin line.
    surfacePath(0);
    ctx.strokeStyle = COLORS.crustGlow;
    ctx.lineWidth = 3.5;
    ctx.globalAlpha = 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = COLORS.crust;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  function drawTrails(r, world) {
    var ctx = r.ctx;
    var i, p, s;
    for (var t = 0; t < world.pastTrails.length; t++) {
      var trail = world.pastTrails[t];
      var age = world.pastTrails.length - t;
      ctx.fillStyle = COLORS.trailOld;
      ctx.globalAlpha = U.clamp(0.30 / age, 0.05, 0.3);
      for (i = 0; i < trail.length; i++) {
        p = trail[i];
        s = worldToScreen(r, p.x, p.y);
        ctx.fillRect(s.x - 1.2, s.y - 1.2, 2.4, 2.4);
      }
      ctx.globalAlpha = 1;
    }

    var live = world.trail || [];
    ctx.fillStyle = COLORS.trailLive;
    for (i = 0; i < live.length; i++) {
      p = live[i];
      s = worldToScreen(r, p.x, p.y);
      var fade = i / Math.max(1, live.length);
      ctx.globalAlpha = 0.15 + 0.65 * fade;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawTanks(r, world) {
    for (var i = 0; i < world.tanks.length; i++) {
      drawTank(r, world, world.tanks[i], i === world.activeIndex && world.state !== 'over');
    }
  }

  function drawTank(r, world, tank, isActive) {
    var ctx = r.ctx;
    var base = worldToScreen(r, tank.x, tank.y);
    var z = r.cam.zoom;
    var body = tank.id === 1 ? COLORS.p1 : COLORS.p2;
    var bodyDark = tank.id === 1 ? COLORS.p1Dark : COLORS.p2Dark;
    var hullW = 30 * z;
    var hullH = 11 * z;
    var trackH = 6 * z;

    ctx.save();
    ctx.translate(base.x, base.y);
    ctx.rotate(-tank.tilt);

    // Ground shadow / glow ring under the active tank.
    if (isActive) {
      var pulse = 0.6 + 0.4 * Math.sin(r.time * 4);
      ctx.save();
      ctx.globalAlpha = 0.35 * pulse;
      ctx.strokeStyle = body;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, -1 * z, 26 * z, 7 * z, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Tracks.
    ctx.fillStyle = tank.alive ? '#141210' : '#0d0b0a';
    roundRect(ctx, -hullW * 0.56, -trackH, hullW * 1.12, trackH, 2.4 * z);
    ctx.fill();
    ctx.strokeStyle = tank.alive ? bodyDark : '#2b2620';
    ctx.lineWidth = 1;
    // Road wheels.
    for (var w = -2; w <= 2; w++) {
      ctx.beginPath();
      ctx.arc(w * (hullW * 0.2), -trackH * 0.5, 1.9 * z, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Hull.
    var hullTop = -trackH - hullH;
    ctx.fillStyle = tank.alive ? bodyDark : COLORS.wreck;
    roundRect(ctx, -hullW * 0.5, hullTop, hullW, hullH, 3 * z);
    ctx.fill();
    ctx.fillStyle = tank.alive ? body : '#3d3730';
    roundRect(ctx, -hullW * 0.42, hullTop + 1.6 * z, hullW * 0.84, hullH * 0.42, 2 * z);
    ctx.fill();

    if (tank.alive) {
      // Turret + barrel, barrel drawn from the real pivot to the real muzzle.
      var pivot = worldToScreen(r, TE.tank.pivotPoint(tank).x, TE.tank.pivotPoint(tank).y);
      var tip = worldToScreen(r, TE.tank.muzzle(tank).x, TE.tank.muzzle(tank).y);
      ctx.strokeStyle = body;
      ctx.lineWidth = 3.4 * z;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pivot.x - base.x, pivot.y - base.y);
      ctx.lineTo(tip.x - base.x, tip.y - base.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, hullTop, 5.4 * z, 0, Math.PI * 2);
      ctx.fillStyle = body;
      ctx.fill();
      ctx.fillStyle = bodyDark;
      ctx.beginPath();
      ctx.arc(0, hullTop, 2.4 * z, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Wreck: canted hull, no barrel.
      ctx.rotate(0.16);
      ctx.fillStyle = '#181410';
      roundRect(ctx, -hullW * 0.4, hullTop - 3 * z, hullW * 0.8, hullH * 0.8, 2 * z);
      ctx.fill();
    }
    ctx.restore();

    drawIntegrityBadge(r, tank, isActive);
  }

  function drawIntegrityBadge(r, tank, isActive) {
    var ctx = r.ctx;
    var ratio = TE.tank.integrityRatio(tank);
    var w = 46;
    var h = 5;
    var p = worldToScreen(r, tank.x, tank.y + 34);
    var x = p.x - w / 2;
    var y = p.y;

    ctx.save();
    ctx.globalAlpha = isActive ? 1 : 0.72;
    ctx.fillStyle = 'rgba(6,10,16,0.78)';
    roundRect(ctx, x - 2, y - 2, w + 4, h + 4, 3);
    ctx.fill();
    ctx.strokeStyle = isActive ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    var col = ratio > 0.6 ? '#4ade80' : (ratio > 0.3 ? '#fbbf24' : '#f87171');
    ctx.fillStyle = tank.alive ? col : '#4b5563';
    roundRect(ctx, x, y, Math.max(0, w * ratio), h, 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(tank.name.replace('Player ', 'P') + ' ' + Math.round(tank.integrity), x + w / 2, y - 6);
    ctx.restore();
  }

  function drawShell(r, world) {
    if (!world.shell) return;
    var ctx = r.ctx;
    var s = world.shell;
    var p = worldToScreen(r, s.x, s.y);
    var prev = worldToScreen(r, s.px, s.py);

    ctx.save();
    // Motion smear.
    ctx.strokeStyle = 'rgba(255,244,214,0.5)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();

    var glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 12 * r.cam.zoom);
    glow.addColorStop(0, 'rgba(255,250,230,0.95)');
    glow.addColorStop(0.35, 'rgba(255,196,110,0.5)');
    glow.addColorStop(1, 'rgba(255,150,60,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 12 * r.cam.zoom, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = COLORS.shell;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.4 * Math.max(0.7, r.cam.zoom), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawParticles(r) {
    var ctx = r.ctx;
    for (var i = 0; i < r.particles.length; i++) {
      var p = r.particles[i];
      var t = p.life / p.maxLife;
      var alpha = 1 - t;
      ctx.globalAlpha = U.clamp(alpha, 0, 1);

      if (p.type === 'ring') {
        var c = worldToScreen(r, p.x, p.y);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2.5 * (1 - t) + 0.5;
        ctx.beginPath();
        ctx.arc(c.x, c.y, p.size * r.cam.zoom, 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.type === 'flash') {
        var f = worldToScreen(r, p.x, p.y);
        var rg = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, Math.max(1, p.size * r.cam.zoom));
        rg.addColorStop(0, p.color);
        rg.addColorStop(1, 'rgba(255,170,80,0)');
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(f.x, f.y, Math.max(1, p.size * r.cam.zoom), 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === 'smoke') {
        drawSmoke(r, p, alpha);
      } else {
        var d = worldToScreen(r, p.x, p.y);
        ctx.fillStyle = p.color;
        var size = Math.max(1, p.size * (p.type === 'dirt' ? 1 : (1 - t * 0.7)) * r.cam.zoom);
        ctx.beginPath();
        ctx.arc(d.x, d.y, size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Aim guide: a dashed ray whose length grows with power. It shows where the
   * barrel points and how hard the shot will be pushed, but not the arc — the
   * player still has to read the wind.
   */
  function drawAimGuide(r, world) {
    if (world.state !== 'aiming') return;
    var tank = world.tanks[world.activeIndex];
    if (!tank || !tank.alive) return;
    var ctx = r.ctx;
    var m = worldToScreen(r, TE.tank.muzzle(tank).x, TE.tank.muzzle(tank).y);
    var aim = TE.tank.aimVector(tank);
    var length = (46 + tank.power * 1.5) * r.cam.zoom;

    ctx.save();
    ctx.setLineDash([5, 6]);
    ctx.lineDashOffset = -(r.time * 26) % 11;
    ctx.strokeStyle = tank.id === 1 ? 'rgba(63,224,196,0.75)' : 'rgba(255,176,87,0.75)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(m.x + aim.x * length, m.y - aim.y * length);
    ctx.stroke();
    ctx.restore();
  }

  function drawFloaters(r) {
    var ctx = r.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '700 15px ui-sans-serif, -apple-system, Segoe UI, Roboto, sans-serif';
    for (var i = 0; i < r.floaters.length; i++) {
      var f = r.floaters[i];
      var p = worldToScreen(r, f.x, f.y);
      var t = f.life / f.maxLife;
      ctx.globalAlpha = U.clamp(1 - t * t, 0, 1);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.strokeText(f.text, p.x, p.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, p.x, p.y);
    }
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, rad) {
    var rr = Math.min(rad, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  /** Replace the alpha component of an "rgba(r,g,b,a)" string. */
  function withAlpha(color, alpha) {
    if (color.charAt(0) !== 'r') return color;
    return color.replace(/[\d.]+\)\s*$/, alpha + ')');
  }

  /**
   * Soft round puff sprite, baked once per colour and reused for every smoke
   * particle. Drawing an image beats re-creating a radial gradient for each of
   * up to 900 particles per frame, which is what makes a rising plume of smoke
   * affordable — and a soft edge is what makes it look like smoke rather than a
   * cluster of hard discs.
   */
  function puffSprite(r, color) {
    if (r.sprites[color]) return r.sprites[color];
    if (!root.document || !root.document.createElement) return null;
    var size = 64;
    var canvas = root.document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var g = canvas.getContext('2d');
    var half = size / 2;
    var grad = g.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, color);
    grad.addColorStop(0.45, withAlpha(color, 0.35));
    grad.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    r.sprites[color] = canvas;
    return canvas;
  }

  function drawSmoke(r, p, alpha) {
    var ctx = r.ctx;
    var point = worldToScreen(r, p.x, p.y);
    var t = p.life / p.maxLife;
    var radius = Math.max(1, p.size * (0.7 + t * 1.1) * r.cam.zoom) * 2.4;
    var sprite = puffSprite(r, p.color);
    ctx.globalAlpha = U.clamp(alpha * 0.7, 0, 1);
    if (sprite && ctx.drawImage) {
      ctx.drawImage(sprite, point.x - radius / 2, point.y - radius / 2, radius, radius);
    } else {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }


  TE.render = {
    COLORS: COLORS,
    create: create,
    resize: resize,
    setSeed: setSeed,
    worldToScreen: worldToScreen,
    screenToWorld: screenToWorld,
    updateCamera: updateCamera,
    updateFx: updateFx,
    addShake: addShake,
    addScorch: addScorch,
    addMuzzleFlash: addMuzzleFlash,
    addExplosion: addExplosion,
    addSparks: addSparks,
    pushFloater: pushFloater,
    draw: draw
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
