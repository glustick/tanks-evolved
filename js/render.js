/**
 * render.js — Canvas 2D presentation: studio-lit dark scene, shell-following
 * camera, particle FX and the in-canvas HUD.
 *
 * Everything in this file is cosmetic. Nothing here may feed back into game
 * state, which is what lets the simulation stay deterministic while the eye
 * candy is allowed to depend on frame timing.
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});
  var C = TE.CONST;
  var U = TE.utils;

  var COLORS = {
    skyTop: '#05070d',
    skyMid: '#0d1524',
    skyLow: '#1d2b45',
    ridgeFar: '#131d31',
    ridgeNear: '#0c1424',
    haze: 'rgba(120,170,255,0.06)',
    groundTop: '#22304a',
    groundDeep: '#080c13',
    crust: '#4d6b93',
    crustGlow: 'rgba(126,196,255,0.5)',
    p1: '#3fe0c4',
    p1Dark: '#0d5148',
    p2: '#ffb057',
    p2Dark: '#5c370f',
    shell: '#fff8e7',
    wreck: '#2a3140'
  };

  var MAX_PARTICLES = 900;

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
      stars: [],
      ridges: [],
      streaks: [],
      sprites: {},
      // Visual-only RNG. Deliberately separate from the match seed: FX may be
      // frame-rate dependent, the simulation never is.
      fxRng: TE.rng.fromSeed('fx-visual'),
      time: 0,
      shake: 0,
      wreckSmokeT: 0,
      skyGrad: null,
      terrainGrad: null
    };
    buildStars(r);
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

  function buildStars(r) {
    var rng = TE.rng.fromSeed('tanks-evolved-stars');
    r.stars = [];
    for (var i = 0; i < 140; i++) {
      r.stars.push({
        x: rng.next(),
        y: rng.next() * 0.55,
        size: rng.range(0.6, 1.7),
        alpha: rng.range(0.18, 0.85),
        phase: rng.range(0, Math.PI * 2)
      });
    }
  }

  /** Regenerate the seed-dependent parallax silhouettes for a new match. */
  function setSeed(r, seed) {
    var rng = TE.rng.derive(seed, 'ridge');
    r.ridges = [];
    var layers = [
      { samples: 33, base: 150, amplitude: 95, parallax: 0.30, color: COLORS.ridgeFar, alpha: 0.9 },
      { samples: 25, base: 95, amplitude: 70, parallax: 0.52, color: COLORS.ridgeNear, alpha: 1 }
    ];
    for (var l = 0; l < layers.length; l++) {
      var cfg = layers[l];
      var points = [];
      var phase = rng.range(0, Math.PI * 2);
      var freq = rng.range(1.1, 2.6);
      var wobble = rng.range(0.5, 1.4);
      for (var i = 0; i <= cfg.samples; i++) {
        var t = i / cfg.samples;
        var y = cfg.base +
          Math.sin(phase + t * Math.PI * freq) * cfg.amplitude +
          Math.sin(phase * 2.3 + t * Math.PI * freq * 3.1) * cfg.amplitude * 0.22 * wobble;
        points.push({ t: t, y: U.clamp(y, 20, 340) });
      }
      r.ridges.push({ points: points, parallax: cfg.parallax, color: cfg.color, alpha: cfg.alpha });
    }
    // Wind streaks: thin horizontal dust lines that drift with the wind.
    r.streaks = [];
    for (var s = 0; s < 26; s++) {
      r.streaks.push({
        x: rng.range(0, C.WORLD_W),
        y: rng.range(30, 420),
        len: rng.range(10, 34),
        speed: rng.range(0.4, 1.1),
        alpha: rng.range(0.05, 0.16)
      });
    }
    return r;
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
    return cam;
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
        size: rng.range(4, 9), color: 'rgba(190,205,225,0.5)'
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
        size: rng.range(1.5, 4.2), color: rng.next() < 0.4 ? '#3b4a63' : '#26313f'
      });
    }
    for (i = 0; i < 14; i++) {
      spawnParticle(r, {
        type: 'smoke',
        x: x + rng.range(-10, 10), y: y + rng.range(-6, 10),
        vx: rng.range(-40, 40), vy: rng.range(20, 90),
        life: 0, maxLife: rng.range(0.9, 2.2),
        size: rng.range(8, 20), color: 'rgba(150,165,185,0.42)'
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
          size: r.fxRng.range(5, 11), color: 'rgba(120,130,148,0.4)'
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
  }

  // ----------------------------------------------------------------- drawing
  function draw(r, world) {
    var ctx = r.ctx;
    var shakeX = r.shake > 0 ? Math.sin(r.time * 61) * r.shake : 0;
    var shakeY = r.shake > 0 ? Math.cos(r.time * 53) * r.shake * 0.6 : 0;

    ctx.save();
    ctx.clearRect(0, 0, r.w, r.h);
    ctx.translate(shakeX, shakeY);
    drawSky(r, world);
    drawRidges(r);
    drawWindStreaks(r, world);
    drawTerrain(r, world);
    drawTrails(r, world);
    drawTanks(r, world);
    drawShell(r, world);
    drawParticles(r);
    drawAimGuide(r, world);
    drawFloaters(r);
    ctx.restore();
  }

  function drawSky(r, world) {
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

    // Stars with a slow parallax drift and a gentle twinkle.
    for (var i = 0; i < r.stars.length; i++) {
      var s = r.stars[i];
      var sx = (s.x * C.WORLD_W - r.cam.x * 0.08) * r.cam.zoom + r.w * 0.5;
      sx = ((sx % r.w) + r.w) % r.w;
      var sy = s.y * r.h * 0.6 - (r.cam.y - C.WORLD_H / 2) * 0.05;
      var twinkle = 0.75 + 0.25 * Math.sin(r.time * 1.4 + s.phase);
      ctx.globalAlpha = s.alpha * twinkle;
      ctx.fillStyle = '#cfe3ff';
      ctx.fillRect(sx, sy, s.size, s.size);
    }
    ctx.globalAlpha = 1;
  }

  function drawRidges(r) {
    var ctx = r.ctx;
    var bottom = r.h + 40;
    for (var l = 0; l < r.ridges.length; l++) {
      var layer = r.ridges[l];
      var n = layer.points.length;
      var zoom = r.cam.zoom;
      var spanPx = C.WORLD_W * zoom;
      // Tiles of the silhouette, laid out in camera space, so the range keeps
      // covering the viewport however far the camera pans.
      var anchor = r.cam.x * layer.parallax;
      var firstTile = Math.floor((anchor - (r.w * 0.5 + 120) / zoom) / C.WORLD_W) - 1;
      var lastTile = Math.ceil((anchor + (r.w * 0.5 + 120) / zoom) / C.WORLD_W) + 1;

      ctx.beginPath();
      ctx.moveTo((firstTile + 0) * spanPx - anchor * zoom + r.w * 0.5, bottom);
      for (var t = firstTile; t <= lastTile; t++) {
        for (var i = 0; i < n; i++) {
          var pt = layer.points[i];
          var sx = ((t + pt.t) * C.WORLD_W - anchor) * zoom + r.w * 0.5;
          var sy = (r.cam.y - pt.y) * zoom + r.h * 0.5;
          ctx.lineTo(sx, sy);
        }
      }
      ctx.lineTo(((lastTile + 1) * C.WORLD_W - anchor) * zoom + r.w * 0.5, bottom);
      ctx.closePath();
      ctx.globalAlpha = layer.alpha;
      ctx.fillStyle = layer.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      // A thin lit edge along the top of each ridge.
      ctx.strokeStyle = l === 0 ? 'rgba(90,130,200,0.13)' : 'rgba(120,180,255,0.16)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function drawWindStreaks(r, world) {
    if (!world) return;
    var mag = Math.abs(world.wind);
    if (mag < 0.05) return;
    var ctx = r.ctx;
    var dir = world.wind > 0 ? 1 : -1;
    ctx.strokeStyle = 'rgb(190,215,255)';
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
      g.addColorStop(0.45, '#17202f');
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
      ctx.strokeStyle = 'rgba(150,190,240,' + strata[s].alpha + ')';
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
    ctx.fillStyle = tank.alive ? '#111823' : '#0b0f16';
    roundRect(ctx, -hullW * 0.56, -trackH, hullW * 1.12, trackH, 2.4 * z);
    ctx.fill();
    ctx.strokeStyle = tank.alive ? bodyDark : '#242a35';
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
    ctx.fillStyle = tank.alive ? body : '#3a4150';
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
      ctx.fillStyle = '#1a1f29';
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
    pushFloater: pushFloater,
    draw: draw
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
