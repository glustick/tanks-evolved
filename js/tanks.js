/**
 * tanks.js — tank state: position, integrity, aim, muzzle geometry, falling.
 *
 * Tanks are static in Phase 0: no driving, no fuel. They do fall when a shell
 * removes the ground beneath them, and a hard landing costs integrity.
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});
  var C = TE.CONST;
  var U = TE.utils;

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
    update: update
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
