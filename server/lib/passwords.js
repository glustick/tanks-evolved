/**
 * passwords.js — scrypt hashing, with the parameters stored beside each hash.
 *
 * The parameters live in the users row rather than in this file, so raising the cost
 * later is a new row's values plus a rehash the next time that player logs in, instead
 * of a migration that invalidates every stored hash at once. Nothing in this module
 * ever puts a password, a salt or a derived key into a log line or an error message.
 */
'use strict';

const crypto = require('node:crypto');

// N=2^15 with r=8 is ~32 MiB per hash: expensive enough that an offline guessing
// attack on a stolen database is slow, cheap enough (~100 ms) that a login is not
// itself a denial-of-service vector — which is what the per-IP rate limit is for.
const DEFAULT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;

// A fixed salt for the "no such account" path below. Its value is irrelevant: it is
// never stored and never compared against anything, it exists only to give scrypt the
// same amount of work to do as a real verification.
const UNKNOWN_SALT = Buffer.alloc(SALT_BYTES, 'tanks-evolved/unknown-account');

/**
 * Node refuses scrypt above `maxmem`, and its 32 MiB default is exactly what N=2^15
 * needs (128 * N * r = 32 MiB), so the ceiling has to be raised explicitly or every
 * hash throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS. Twice the requirement leaves room to
 * raise N without the failure mode being a confusing runtime error.
 */
function maxmemFor(params) {
  return 256 * params.N * params.r;
}

/** Raw scrypt derivation. The only place the algorithm is named. */
function derive(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: maxmemFor(params) },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

/**
 * Hash a new password.
 * @returns {Promise<{passwordHash: string, passwordSalt: string, kdf: string,
 *   kdfN: number, kdfR: number, kdfP: number, kdfKeylen: number}>} a row's worth of fields
 */
async function hash(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, DEFAULT_PARAMS);
  return {
    passwordHash: key.toString('hex'),
    passwordSalt: salt.toString('hex'),
    kdf: 'scrypt',
    kdfN: DEFAULT_PARAMS.N,
    kdfR: DEFAULT_PARAMS.r,
    kdfP: DEFAULT_PARAMS.p,
    kdfKeylen: DEFAULT_PARAMS.keylen
  };
}

/**
 * Check a password against a stored user row.
 * @param {string} password
 * @param {object} row a users row, as returned by db.findUserByEmail
 * @returns {Promise<boolean>}
 */
async function verify(password, row) {
  const params = { N: row.kdf_n, r: row.kdf_r, p: row.kdf_p, keylen: row.kdf_keylen };
  const expected = Buffer.from(row.password_hash, 'hex');
  const actual = await derive(password, Buffer.from(row.password_salt, 'hex'), params);
  // timingSafeEqual throws on a length mismatch, and a stored key of the wrong length
  // is a corrupt row rather than a match.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Spend the same work as `verify` on an address that has no account, and say no.
 *
 * This is the whole of the no-enumeration guarantee on login: if an unknown address
 * returned early, the difference between "10 ms" and "110 ms" would tell an attacker
 * which addresses are registered, whatever the response body said. The return value is
 * constant because the caller must not be able to branch on it differently by mistake.
 */
async function verifyUnknown(password) {
  await derive(password, UNKNOWN_SALT, DEFAULT_PARAMS);
  return false;
}

module.exports = { hash, verify, verifyUnknown, DEFAULT_PARAMS, SALT_BYTES };
