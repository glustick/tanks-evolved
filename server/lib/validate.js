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
 */
'use strict';

const { httpError } = require('./http');

// RFC 5321's limit on the path, and the smallest password length worth hashing.
const EMAIL_MAX = 254;
const PASSWORD_MIN = 8;
// scrypt hashes whatever it is given, so the input length only has to be bounded to
// keep a single request's work bounded. 1024 is well past any password manager.
const PASSWORD_MAX = 1024;

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

module.exports = { normalizeEmail, requireEmail, requirePassword, EMAIL_MAX, PASSWORD_MIN, PASSWORD_MAX };
