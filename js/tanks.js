/**
 * tanks.js — tank state: position, integrity, aim, muzzle geometry, driving, falling.
 *
 * A tank drives by walking the surface: it moves a terrain sample at a time, the
 * ground under it is re-read at each one, and it either follows the ground or falls
 * to it. There is no second path for "the ground under a tank changed" — the walk
 * calls the same `update()` the settling phase drives, so driving off a crater wall
 * and having a crater blown out from under you land, damage and settle identically.
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});
  var C = TE.CONST;
  var U = TE.utils;

  // A fall that never lands is impossible on a 760-unit-tall map, so this only bounds
  // the loop: 400 steps of SIM_STEP is 3.3 seconds, further than anything can drop.
  var FALL_STEP_LIMIT = 400;

  /**
   * @param {number} id 1 or 2
   * @param {number} x world x
   * @param {object} terrain
   */
  function create(id, x, terrain) {
    var tank = {
      id: id,
      name: 'Player ' + id,
      facing: id === 1 ? 1 : -1, // shells travel toward +x for player 1
      x: x,
      y: 0,                      // ground contact point
      vy: 0,
      onGround: true,
      tilt: 0,                   // render-only hull rotation, from local slope
      integrity: C.TANK_INTEGRITY,
      angle: 45,                 // elevation in degrees, 0..90, toward `facing`
      power: 60,                 // muzzle power, 5..100
      alive: true
    };
    snapToGround(tank, terrain);
    return tank;
  }

  /** Place the tank exactly on the surface and level it with the slope. */
  function snapToGround(tank, terrain) {
    tank.y = TE.terrain.heightAt(terrain, tank.x);
    tank.vy = 0;
    tank.onGround = true;
    updateTilt(tank, terrain);
    return tank;
  }

  function updateTilt(tank, terrain) {
    tank.tilt = Math.atan(TE.terrain.slopeAt(terrain, tank.x, 12));
    return tank.tilt;
  }

  /** Centre of the hit circle / hull. */
  function bodyCenter(tank) {
    return { x: tank.x, y: tank.y + C.TANK_BODY_OFFSET };
  }

  /**
   * Barrel tip in world space: shells are spawned here so the muzzle flash and
   * the visible barrel agree with where the shot actually starts.
   */
  function muzzle(tank) {
    return muzzleFrom(tank, 0);
  }

  /** Barrel tip for an aim direction offset by `angleOffsetDeg` degrees. */
  function muzzleFrom(tank, angleOffsetDeg) {
    var rad = U.toRad(tank.angle + (angleOffsetDeg || 0));
    var pivot = pivotPoint(tank);
    return {
      x: pivot.x + Math.cos(rad) * C.TANK_BARREL * tank.facing,
      y: pivot.y + Math.sin(rad) * C.TANK_BARREL
    };
  }

  /** Barrel pivot (turret centre) in world space. */
  function pivotPoint(tank) {
    return { x: tank.x, y: tank.y + C.TANK_BODY_OFFSET + 3 };
  }

  /** Unit vector the barrel points along (y-up world space). */
  function aimVector(tank) {
    var rad = U.toRad(tank.angle);
    return { x: Math.cos(rad) * tank.facing, y: Math.sin(rad) };
  }

  /** Does a point hit this tank's body circle? */
  function hitTest(tank, x, y, radius) {
    var c = bodyCenter(tank);
    return U.dist(x, y, c.x, c.y) <= (radius == null ? C.TANK_RADIUS : radius);
  }

  /** Apply damage; clamps to zero and flips `alive`. */
  function damage(tank, amount) {
    if (amount <= 0 || !tank.alive) return 0;
    var before = tank.integrity;
    tank.integrity = U.clamp(tank.integrity - amount, 0, C.TANK_INTEGRITY);
    if (tank.integrity <= 0) tank.alive = false;
    return before - tank.integrity;
  }

  function integrityRatio(tank) {
    return tank.integrity / C.TANK_INTEGRITY;
  }

  function setAngle(tank, deg) {
    tank.angle = U.clamp(deg, C.TANK_MIN_ANGLE, C.TANK_MAX_ANGLE);
    return tank.angle;
  }

  function setPower(tank, value) {
    tank.power = U.clamp(value, C.TANK_MIN_POWER, C.TANK_MAX_POWER);
    return tank.power;
  }

  /**
   * Advance a falling tank by dt. Returns null when nothing happened, or
   * { landed, speed, damage } on the step the tank touches down.
   */
  function update(tank, dt, terrain) {
    var ground = TE.terrain.heightAt(terrain, tank.x);
    updateTilt(tank, terrain);

    // Ground rose above the tank (impossible with dig-only craters, but cheap
    // to handle): push the tank up so it can never be buried.
    if (tank.onGround && tank.y < ground) {
      tank.y = ground;
      return null;
    }

    if (tank.onGround && tank.y <= ground + 0.01) {
      tank.y = ground; // settle onto sloped ground
      return null;
    }

    tank.onGround = false;
    tank.vy -= C.GRAVITY * dt;
    tank.y += tank.vy * dt;

    if (tank.y <= ground) {
      var speed = Math.abs(tank.vy);
      tank.y = ground;
      tank.vy = 0;
      tank.onGround = true;
      var damageTaken = Math.max(0, (speed - C.FALL_SAFE_SPEED) / C.FALL_DAMAGE_DIVISOR);
      return { landed: true, speed: speed, damage: damageTaken };
    }
    return { landed: false, speed: Math.abs(tank.vy), damage: 0 };
  }

  /**
   * Walk the tank `dx` world units along x (negative is backward) and let the ground
   * under it change as it goes.
   *
   * One terrain sample per step, so the tank follows the surface instead of stepping
   * over it, and the ground under it is re-resolved after every one: the move is spent
   * where the tank ends up, not where the player aimed it. A barrier stops it — the
   * walk halts at the face and reports it, rather than refusing the whole drive, so
   * clipping a wall costs the tank the distance it could not cover and nothing else.
   *
   * `onLanding` is called with whatever the falling path reports on the step the tank
   * touches down, and it is what applies the damage: the caller owns the damage/hook
   * pairing, so a driving fall and a crater-edge fall are resolved by one piece of
   * code rather than two. A landing the caller makes fatal ends the walk there — a
   * wreck does not drive. A table-driven walk is bounded by the terrain in front of it,
   * so the result is a pure function of (tank, terrain, cover, dx) — the whole reason
   * a move can be relayed as a single number.
   *
   * @returns {{travelled:number, blocked:boolean}} distance actually covered, in world units
   */
  function walk(tank, terrain, cover, dx, onLanding) {
    var dir = dx < 0 ? -1 : 1;
    var remaining = Math.abs(dx);
    var travelled = 0;
    var blocked = false;

    while (remaining > 1e-9 && tank.alive) {
      var step = Math.min(C.TERRAIN_STEP, remaining);
      var nextX = tank.x + dir * step;
      // The block's footprint is the test, not its height. Cover is embedded in the
      // ground and its top is fixed map geometry, so "is it in the way" has one answer
      // that holds for every tank on every map; testing against the top instead would
      // let a tank pass over a low wall and leave it inside the block the moment the
      // ground under it dropped. See terrain.js coverBlocksX.
      if (TE.terrain.coverBlocksX(cover, nextX, C.TANK_RADIUS)) {
        blocked = true;
        break;
      }
      tank.x = nextX;
      travelled += step;
      remaining -= step;
      follow(tank, terrain, step, onLanding);
    }

    return { travelled: travelled, blocked: blocked };
  }

  /**
   * The ground under the tank changed: follow it, or fall to it.
   *
   * Uphill the tank is pushed onto the surface and downhill it follows while the
   * ground falls away no faster than the tracks will hold. Past MOVE_GRADE_MAX it is
   * unsupported, and from there this is the falling path — the same `update()` and so
   * the same landing speed and damage a tank gets when a crater takes the ground it
   * was standing on.
   *
   * @param {number} step the horizontal distance just covered, so the comparison is a
   *   gradient rather than a height (a long step over the same ground falls sooner)
   */
  function follow(tank, terrain, step, onLanding) {
    var ground = TE.terrain.heightAt(terrain, tank.x);
    var drop = tank.y - ground;

    if (drop <= 0) {
      tank.y = ground;
      tank.vy = 0;
      tank.onGround = true;
      updateTilt(tank, terrain);
      return null;
    }

    if (tank.onGround && drop <= C.MOVE_GRADE_MAX * step) {
      tank.y = ground;
      tank.vy = 0;
      updateTilt(tank, terrain);
      return null;
    }

    return fallToGround(tank, terrain, onLanding);
  }

  /**
   * Run the falling path until the tank is standing again.
   *
   * The steps are the settling phase's own — SIM_STEP, the same dt game.js passes in
   * its settling loop — because the landing speed this produces has to be the landing
   * speed a shell-driven collapse produces at the same height. A walk has no wall
   * clock to wait on: the whole move has to resolve inside one call.
   */
  function fallToGround(tank, terrain, onLanding) {
    var result = null;
    for (var i = 0; i < FALL_STEP_LIMIT; i++) {
      result = update(tank, C.SIM_STEP, terrain);
      if (tank.onGround) break;
    }
    if (result && result.landed && onLanding) onLanding(result);
    return result;
  }

  TE.tank = {
    create: create,
    snapToGround: snapToGround,
    updateTilt: updateTilt,
    bodyCenter: bodyCenter,
    pivotPoint: pivotPoint,
    muzzle: muzzle,
    aimVector: aimVector,
    hitTest: hitTest,
    damage: damage,
    integrityRatio: integrityRatio,
    setAngle: setAngle,
    setPower: setPower,
    walk: walk,
    update: update
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
