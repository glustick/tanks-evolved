/**
 * db.js — the whole persistence layer: one SQLite file, two tables, and the handful of
 * statements the API needs.
 *
 * node:sqlite is synchronous, which is the right shape here. These are index lookups
 * against a local file that take microseconds, so wrapping them in promises would add
 * machinery without adding throughput — the expensive part of a login is scrypt, and
 * it happens outside this module.
 *
 * The schema is applied on boot with CREATE TABLE IF NOT EXISTS, so a fresh volume is a
 * working database and a restart is a no-op. No migration framework: two tables whose
 * shape is only ever added to do not need one yet.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('./fail');

/**
 * The DDL. Kept as one string because it is one idea — "the schema" — and read in the
 * order the tables depend on each other.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    password_salt TEXT    NOT NULL,
    -- The KDF and its parameters are recorded per row rather than assumed from the
    -- code, so raising the cost later is a rehash on next login for existing accounts
    -- instead of a flag day that invalidates every stored hash at once.
    kdf           TEXT    NOT NULL,
    kdf_n         INTEGER NOT NULL,
    kdf_r         INTEGER NOT NULL,
    kdf_p         INTEGER NOT NULL,
    kdf_keylen    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- sha256 of the cookie value. The token itself is never written here, so this
    -- table is not a set of usable credentials.
    token_hash TEXT    NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- Every authenticated request arrives here; the UNIQUE on token_hash is what serves
  -- that lookup. This index is for the sweeps and for the ON DELETE CASCADE.
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
`;

/**
 * PRAGMAs are applied per connection, on every boot. WAL keeps readers from blocking on
 * the writer; foreign_keys is off by default in SQLite, without it the cascade above is
 * inert; NORMAL is the conventional WAL companion, keeping durability across a process
 * crash while accepting the loss of the last commits to a host power cut.
 */
const PRAGMAS = ['journal_mode = WAL', 'foreign_keys = ON', 'busy_timeout = 5000', 'synchronous = NORMAL'];

/**
 * Load node:sqlite, or explain in one line why this runtime cannot run the server.
 *
 * Feature-detected rather than version-checked: what matters is whether the module
 * loads and exposes DatabaseSync, not what the version string says.
 */
function loadSqlite() {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    fail(`node:sqlite is not available on ${process.version}. ` +
      'Run the server on Node 24 or newer (node:sqlite is unflagged from 23.4; on 22.x it needs --experimental-sqlite).');
  }
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
    fail(`node:sqlite on ${process.version} does not provide DatabaseSync. Run the server on Node 24 or newer.`);
  }
  return sqlite;
}

/** A UNIQUE violation, by SQLite's own result code (2067) with the message as backup. */
function isUniqueViolation(err) {
  if (!err) return false;
  if (err.errcode === 2067) return true;
  return /UNIQUE constraint failed/i.test(String(err.message));
}

/**
 * One line for the operator. SQLite's `code` on its own is "ERR_SQLITE_ERROR", which says
 * nothing about what to fix — the message ("unable to open database file") is the part
 * that points at a permission or a missing mount, so both are reported.
 */
function describe(err) {
  if (!err) return 'unknown error';
  const code = err.code || err.errstr;
  const message = err.message;
  if (!message) return code ? String(code) : String(err);
  return code && !message.includes(String(code)) ? `${code}: ${message}` : message;
}

/**
 * Open (creating if needed) the database and make sure the schema is present.
 *
 * The directory is created here rather than expected to exist: the container bind-mounts
 * it and a fresh host directory is empty, so "a fresh volume just works" is this
 * function's job. A failure to create it is fatal and reported in one line — the server
 * has nothing to serve without storage, and starting anyway would turn a permissions
 * mistake into a confusing 500 on the first registration.
 */
function openDatabase(file) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    fail(`cannot create the database directory ${dir}: ${describe(err)}`);
  }

  const { DatabaseSync } = loadSqlite();
  let db;
  try {
    db = new DatabaseSync(file);
  } catch (err) {
    fail(`cannot open the database ${file}: ${describe(err)}`);
  }

  try {
    for (const pragma of PRAGMAS) db.prepare(`PRAGMA ${pragma}`).get();
    db.exec(SCHEMA);
  } catch (err) {
    fail(`cannot prepare the database ${file}: ${describe(err)}`);
  }
  return db;
}

function closeDatabase(db) {
  try {
    db.close();
  } catch {
    // Closing on the way out: a failure here has nothing left to affect.
  }
}

// ---------------------------------------------------------------------- users

/**
 * Insert an account, returning its id or null when the email is already taken.
 *
 * The UNIQUE index is the authority on duplicates, not a SELECT first: the insert is a
 * single statement that either wins or loses, and the failure mode of a lost race is a
 * handled 409 rather than two rows.
 */
function insertUser(db, user) {
  try {
    const info = db.prepare(
      `INSERT INTO users (email, password_hash, password_salt, kdf, kdf_n, kdf_r, kdf_p, kdf_keylen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      user.email,
      user.passwordHash,
      user.passwordSalt,
      user.kdf,
      user.kdfN,
      user.kdfR,
      user.kdfP,
      user.kdfKeylen,
      user.createdAt
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/** The row for an email, hash columns included — this one is for the login path only. */
function findUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

/**
 * The public shape of a user. Every response body goes through here, which is what makes
 * "the hash never leaves the server" a property of one function rather than a rule to
 * remember at each call site.
 */
function toPublicUser(row) {
  return { id: Number(row.id), email: row.email, createdAt: Number(row.created_at) };
}

// ------------------------------------------------------------------- sessions

function insertSession(db, session) {
  db.prepare(
    'INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(session.userId, session.tokenHash, session.createdAt, session.expiresAt);
}

/**
 * Resolve a session token hash to its session and user in one statement, or null.
 *
 * Expiry is enforced here, on the read that would have used the row, rather than by a
 * timer: there is no scheduler to keep the process alive for and no window in which a
 * stale row still authenticates.
 */
function findSessionUser(db, tokenHash, now) {
  const row = db.prepare(
    `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.email, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).get(tokenHash);

  if (!row) return null;
  if (Number(row.expires_at) <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
    return null;
  }
  return {
    sessionId: Number(row.session_id),
    expiresAt: Number(row.expires_at),
    user: toPublicUser({ id: row.user_id, email: row.email, created_at: row.created_at })
  };
}

/** Forget a session. Idempotent: a token that is not there is already the desired state. */
function deleteSession(db, tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

/**
 * Drop sessions that have expired. Called once at boot so the table does not grow
 * forever if nothing ever reads the expired rows.
 */
function deleteExpiredSessions(db, now) {
  return Number(db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes);
}

module.exports = {
  openDatabase,
  closeDatabase,
  insertUser,
  findUserByEmail,
  toPublicUser,
  insertSession,
  findSessionUser,
  deleteSession,
  deleteExpiredSessions,
  isUniqueViolation
};
