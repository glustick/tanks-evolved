/**
 * validate.js — the only place input from the network becomes a value the rest of the
 * server trusts.
 *
 * Email is normalised to lowercase and trimmed and then treated as an opaque lookup
 * key: the server has no reason to know which RFC 5322 address a string is, only that
 * it is plausible, bounded, and always the same string for the same human. The check
 * is on *shape* and never on existence — a malformed address is rejected the same way
 * whether or not an account could ever have it, which is the whole reason login and
 * register share these functions.
 *
 * A shot and a chat message are the same kind of thing: a value one player sends and the
 * other receives, so what bounds them is what the *other* player can be made to hold or
 * render, not what the sender meant.
 */
'use strict';

const { httpError } = require('./http');

// RFC 5321's limit on the path, and the smallest password length worth hashing.
const EMAIL_MAX = 254;
const PASSWORD_MIN = 8;
// scrypt hashes whatever it is given, so the input length only has to be bounded to
// keep a single request's work bounded. 1024 is well past any password manager.
const PASSWORD_MAX = 1024;

/**
 * The aim a shot may carry, in the units the client's own controls produce.
 *
 * These are the simulation's limits (js/utils.js CONST.TANK_MIN_ANGLE and friends), and
 * they are duplicated here rather than shared because the server may not load the
 * client's code: what matters is that a shot the server accepts and relays is one both
 * clients will fire rather than clamp, which would be a divergence with the same turn
 * number on each board.
 */
const ANGLE_MIN = 0;
const ANGLE_MAX = 90;
const POWER_MIN = 5;
const POWER_MAX = 100;

// The state hash is a fingerprint string the client builds, not something the server
// parses. It has to be bounded so it cannot be used to fill the database a turn at a
// time, and non-empty so an unverifiable turn is refused rather than stored as a blank.
const STATE_HASH_MAX = 1024;

// One screen of text. Long enough for a sentence a player would actually type twice over,
// short enough that a chat log stays readable and a message cannot be a payload.
const MESSAGE_MAX = 500;

// Conservative on purpose. It requires a dot in the domain (so `player@localhost` and
// bare words are rejected, which is where typos land) and forbids whitespace and a
// second `@`. A stricter grammar would reject addresses that work, and the only thing
// that can actually confirm an address is an email arriving at it.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * The stored form of an email address: lowercase, trimmed, or null if unusable.
 * Lowercasing here is what makes the UNIQUE index on users.email case-insensitive in
 * practice, without needing a NOCASE collation that would change comparison for every
 * other query on the column.
 */
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX) return null;
  if (!EMAIL_PATTERN.test(email)) return null;
  return email;
}

/**
 * Pull a valid email out of a request body.
 * @throws httpError 400 when the field is absent, not a string, or malformed
 */
function requireEmail(body) {
  const email = normalizeEmail(body.email);
  if (email === null) {
    throw httpError(400, 'invalid_email', 'enter a valid email address');
  }
  return email;
}

/**
 * Pull a usable password out of a request body.
 *
 * The length floor is enforced on login as well as register: a password shorter than
 * the registration rule cannot be the right one, so there is nothing to look up and
 * no reason to spend a scrypt hash finding that out.
 * @throws httpError 400 when the field is absent, not a string, or the wrong length
 */
function requirePassword(body) {
  const password = body.password;
  if (typeof password !== 'string' || password.length === 0) {
    throw httpError(400, 'invalid_password', 'enter a password');
  }
  if (password.length < PASSWORD_MIN) {
    throw httpError(400, 'invalid_password', `password must be at least ${PASSWORD_MIN} characters`);
  }
  if (password.length > PASSWORD_MAX) {
    throw httpError(400, 'invalid_password', `password must be at most ${PASSWORD_MAX} characters`);
  }
  return password;
}

/**
 * Pull a shot out of a request body.
 *
 * Rejected rather than clamped, and this is the one place where that matters most: the
 * server never simulates, so a value it lets through is a value both clients will act on.
 * Silently clamping here would mean the shooter's board (which used its own number) and
 * the opponent's (which used the server's) diverge from the same turn onwards, with a
 * matching turn number and no way to tell which of them is wrong.
 *
 * @throws httpError 400 when the aim is missing, not a number, out of range, or the hash
 *   is missing, empty or absurd
 */
function requireShot(body) {
  const angle = body.angle;
  const power = body.power;

  if (!Number.isFinite(angle) || angle < ANGLE_MIN || angle > ANGLE_MAX) {
    throw httpError(400, 'invalid_angle', `angle must be a number in [${ANGLE_MIN}, ${ANGLE_MAX}]`);
  }
  if (!Number.isFinite(power) || power < POWER_MIN || power > POWER_MAX) {
    throw httpError(400, 'invalid_power', `power must be a number in [${POWER_MIN}, ${POWER_MAX}]`);
  }

  const stateHash = body.stateHash;
  if (typeof stateHash !== 'string' || stateHash.length === 0 || stateHash.length > STATE_HASH_MAX) {
    throw httpError(400, 'invalid_state_hash',
      `stateHash must be a string of 1 to ${STATE_HASH_MAX} characters`);
  }

  return { angle, power, stateHash };
}

/**
 * Pull a chat message out of a request body, trimmed.
 *
 * Trimmed before it is measured, so a message of nothing but spaces is empty rather than
 * a valid 40-character message that renders as a blank line in somebody's chat log.
 *
 * @throws httpError 400 when the text is missing, blank, or over the cap
 */
function requireMessage(body) {
  if (typeof body.text !== 'string') {
    throw httpError(400, 'invalid_message', 'send a "text" field with your message');
  }

  const text = body.text.trim();
  if (text.length === 0) throw httpError(400, 'empty_message', 'the message is empty');
  if (text.length > MESSAGE_MAX) {
    throw httpError(400, 'message_too_long', `a message may be at most ${MESSAGE_MAX} characters`);
  }
  return text;
}

/**
 * Pull the winner out of a result report, as one of this game's two players or null.
 *
 * null is a real answer rather than a missing one: both tanks can go up in the same blast,
 * and the simulation calls that a draw. Anything else — a third player, a string, a
 * float — is refused, because a winner the game never had cannot be agreed on by the two
 * clients and must not reach the row.
 *
 * @throws httpError 400 when the field is not one of the two participants or null
 */
function requireWinner(body, game) {
  const winner = body.winnerUserId;
  if (winner === null || winner === undefined) return null;

  const ids = [game.host.id, game.guest === null ? null : game.guest.id];
  if (!Number.isInteger(winner) || !ids.includes(winner)) {
    throw httpError(400, 'invalid_winner', 'winnerUserId must be one of the two players, or null for a draw');
  }
  return winner;
}

/** The client's fingerprint of the final board. Same shape and bounds as a shot's. */
function requireStateHash(body) {
  const stateHash = body.stateHash;
  if (typeof stateHash !== 'string' || stateHash.length === 0 || stateHash.length > STATE_HASH_MAX) {
    throw httpError(400, 'invalid_state_hash',
      `stateHash must be a string of 1 to ${STATE_HASH_MAX} characters`);
  }
  return stateHash;
}

module.exports = {
  normalizeEmail,
  requireEmail,
  requirePassword,
  requireShot,
  requireMessage,
  requireWinner,
  requireStateHash,
  EMAIL_MAX,
  PASSWORD_MIN,
  PASSWORD_MAX,
  ANGLE_MIN,
  ANGLE_MAX,
  POWER_MIN,
  POWER_MAX,
  MESSAGE_MAX,
  STATE_HASH_MAX
};
