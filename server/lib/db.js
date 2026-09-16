/**
 * db.js — the whole persistence layer: one SQLite file, five tables, and the handful of
 * statements the API needs.
 *
 * node:sqlite is synchronous, which is the right shape here. These are index lookups
 * against a local file that take microseconds, so wrapping them in promises would add
 * machinery without adding throughput — the expensive part of a login is scrypt, and
 * it happens outside this module.
 *
 * The schema is applied on boot with CREATE TABLE IF NOT EXISTS, so a fresh volume is a
 * working database and a restart is a no-op. A *column* added to a table that already
 * exists is the one thing that statement cannot do — the deployed volume predates
 * Phase 2 — so those go through MIGRATIONS below. Everything else is genuinely
 * additive, which is why there is still no migration framework.
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
    created_at    INTEGER NOT NULL,
    -- What other players see, and the only part of an account that leaves the server:
    -- an email address is a credential-recovery target and is nobody else's business.
    -- The DEFAULT exists for MIGRATIONS' sake (a NOT NULL column needs one to be added
    -- to an existing table); every write path supplies a real value.
    display_name  TEXT    NOT NULL DEFAULT ''
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

  -- A game is one row for its whole life: open (hosted, waiting for an opponent),
  -- playing (both players known, seed issued) and finished (ended, with or without a
  -- winner). A NULL winner_id on a finished game means a draw or a desync, and the desync
  -- flag says which.
  CREATE TABLE IF NOT EXISTS games (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    -- NULL until somebody joins. The seed is issued by the server at that moment and
    -- by nobody else, which is what makes it trustworthy as a shared map.
    seed        TEXT,
    host_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- NULL while the game is open, which is also how "is there an opponent" is read.
    guest_id    INTEGER          REFERENCES users(id) ON DELETE CASCADE,
    status      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    started_at  INTEGER,
    winner_id   INTEGER          REFERENCES users(id),
    finished_at INTEGER,
    -- Set when the two clients reported results that do not match. A boolean, stored the
    -- way SQLite stores booleans, so a flag added by MIGRATIONS and one created here have
    -- the same type.
    desync      INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_games_host_id ON games (host_id);
  CREATE INDEX IF NOT EXISTS idx_games_guest_id ON games (guest_id);
  CREATE INDEX IF NOT EXISTS idx_games_status ON games (status);

  -- The replay log, and the whole reason a reloaded tab can rejoin a match in progress: a
  -- shot is (angle, power) and the simulation is deterministic, so replaying these in turn
  -- order from the same seed rebuilds exactly the board both players are looking at.
  --
  -- The hash stored with each one is the fingerprint of the world as that shot was fired.
  -- It is not needed to replay — it is what lets a replay *check itself* at every turn
  -- rather than only agreeing at the end, and what the two clients are compared on when
  -- they report a result.
  CREATE TABLE IF NOT EXISTS shots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    -- 1-based and dense: the shot count is what "whose turn is it" is derived from, so a
    -- gap would change whose turn it is as well as losing a shot.
    turn       INTEGER NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    angle      REAL    NOT NULL,
    power      REAL    NOT NULL,
    state_hash TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- One shot per turn, enforced by the database rather than by a read-then-write: two
  -- requests for the same turn both run the insert, exactly one changes a row, and the
  -- other is told the turn is already played instead of quietly overwriting it or leaving
  -- the replay log with two shots the same turn cannot replay.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_shots_game_turn ON shots (game_id, turn);

  -- In-match chat. Stored rather than relayed and forgotten because a reconnecting player
  -- has to see what was said while they were gone, which is the same requirement the shot
  -- log answers for the board.
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_game_id ON messages (game_id, id);
`;

/**
 * Columns that were added to a table after that table was first deployed.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a volume that already has the table, so a
 * column written into SCHEMA above would never reach the running database: the table
 * exists, and SQLite is never asked to create it. Each entry is therefore applied by
 * name — PRAGMA first, ALTER only if the column is absent — which is idempotent on both
 * the fresh and the deployed path, and is what keeps a deploy from being a flag day.
 *
 * `backfill` is optional: it is there for a column that has to have a sensible value for
 * rows that already exist. A column that is meaningful only from now on, such as when a
 * match ended, has nothing to say about rows written before it did.
 */
const MIGRATIONS = [
  {
    table: 'users',
    column: 'display_name',
    add: "ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''",
    // Existing accounts get the local part of their address, which is exactly what
    // displayNameFor() gives a new one, so there is one rule for both rather than a
    // generation of accounts that behaves differently.
    backfill: `UPDATE users
                  SET display_name = CASE WHEN instr(email, '@') > 1
                                          THEN substr(email, 1, instr(email, '@') - 1)
                                          ELSE email END
                WHERE display_name = '' OR display_name IS NULL`
  },
  // The three a match needs to be able to end. Deliberately no backfill: a game that was
  // played before this deploy ended with nobody's name on it, and inventing a winner for
  // it now would be worse than leaving it blank. Nor is there a REFERENCES clause on
  // winner_id — the winner is a record of what happened, not a live relationship, and a
  // cascade from users is the wrong direction for it.
  { table: 'games', column: 'winner_id', add: 'ALTER TABLE games ADD COLUMN winner_id INTEGER' },
  { table: 'games', column: 'finished_at', add: 'ALTER TABLE games ADD COLUMN finished_at INTEGER' },
  { table: 'games', column: 'desync', add: 'ALTER TABLE games ADD COLUMN desync INTEGER NOT NULL DEFAULT 0' }
];

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
 * Apply MIGRATIONS to a database that may already hold data.
 *
 * The column list comes from PRAGMA table_info rather than from a version number: what
 * matters is whether this column is here, and asking the table itself cannot drift out
 * of step with the file the way a recorded version can.
 */
function applyMigrations(db) {
  for (const migration of MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${migration.table})`).all().map((row) => row.name);
    if (columns.includes(migration.column)) continue;
    db.exec(migration.add);
    if (migration.backfill) db.exec(migration.backfill);
  }
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
    applyMigrations(db);
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

/** A display name is rendered in somebody else's lobby list, so it is bounded. */
const DISPLAY_NAME_MAX = 32;

/**
 * The display name for an account: the local part of its address.
 *
 * Derived rather than asked for, because Phase 2 has no profile editing and a name is
 * needed the moment an account exists. The same rule is what the migration above
 * computes in SQL for accounts that predate the column. Not unique, and never an
 * identity: the user id is, and this is only ever a label next to it.
 */
function displayNameFor(email) {
  const at = email.indexOf('@');
  const local = at > 0 ? email.slice(0, at) : email;
  return local.slice(0, DISPLAY_NAME_MAX);
}

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
      `INSERT INTO users (email, password_hash, password_salt, kdf, kdf_n, kdf_r, kdf_p, kdf_keylen, created_at, display_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      user.email,
      user.passwordHash,
      user.passwordSalt,
      user.kdf,
      user.kdfN,
      user.kdfR,
      user.kdfP,
      user.kdfKeylen,
      user.createdAt,
      displayNameFor(user.email)
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

/** The row for an id, for the paths that need a display name rather than a password. */
function findUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

/**
 * The public shape of *your own* account. Every response body about the caller goes
 * through here, which is what makes "the hash never leaves the server" a property of one
 * function rather than a rule to remember at each call site.
 */
function toPublicUser(row) {
  return { id: Number(row.id), email: row.email, createdAt: Number(row.created_at) };
}

/**
 * The public shape of *any* player, including other players. Two fields, on purpose:
 * an id to key on and a name to render. Anything added here is visible to everyone who
 * can see a game, so an email address can never be one of them.
 */
function toPublicPlayer(row) {
  return { id: Number(row.id), displayName: row.display_name };
}

// ---------------------------------------------------------------------- games

// The three states a game can be in. Exported rather than spelled out at each call site
// because they are compared in several places and a typo would read as "not open".
const GAME_OPEN = 'open';
const GAME_PLAYING = 'playing';
const GAME_FINISHED = 'finished';

/**
 * The row shape every game query returns: the game, plus the display name of each
 * participant in the same statement. Joining here rather than per game is what keeps the
 * lobby a single query — and joining users at all is what makes an email address
 * structurally impossible to leak through a game.
 */
const GAME_COLUMNS = `
  SELECT g.id, g.seed, g.status, g.created_at, g.started_at,
         g.winner_id, g.finished_at, g.desync,
         h.id AS host_id, h.display_name AS host_name,
         u.id AS guest_id, u.display_name AS guest_name,
         w.display_name AS winner_name
    FROM games g
    JOIN users h ON h.id = g.host_id
    LEFT JOIN users u ON u.id = g.guest_id
    LEFT JOIN users w ON w.id = g.winner_id
`;

/**
 * The public shape of a game. The only place a game becomes a response body.
 *
 * `winner` is a player object rather than a bare id, for the same reason neither player
 * is a bare id: the client has a name to render and nothing else to look an id up with.
 * A finished game with no winner is a draw or a desync, and `desync` distinguishes them.
 */
function toPublicGame(row) {
  return {
    id: Number(row.id),
    status: row.status,
    seed: row.seed === null ? null : String(row.seed),
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    host: { id: Number(row.host_id), displayName: row.host_name },
    guest: row.guest_id === null ? null : { id: Number(row.guest_id), displayName: row.guest_name },
    winner: row.winner_id === null || row.winner_id === undefined
      ? null
      : { id: Number(row.winner_id), displayName: row.winner_name },
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
    desync: Boolean(row.desync)
  };
}

/**
 * Whose turn it is, from the shot count alone: the host plays odd turns.
 *
 * Derived rather than stored, which is the whole reason a shot cannot be sent out of
 * turn — the server knows the answer without trusting anybody, and it cannot drift out of
 * step with the replay log because it *is* the replay log. `turn` is 1-based, so it is
 * always one more than the number of shots already played.
 */
function activeUserIdFor(game, turn) {
  if (turn % 2 === 1) return game.host.id;
  return game.guest === null ? null : game.guest.id;
}


function findGameById(db, id) {
  return db.prepare(`${GAME_COLUMNS} WHERE g.id = ?`).get(id) || null;
}

/** Newest first: a player scrolling the lobby wants the game that just appeared on top. */
function listOpenGames(db) {
  return db.prepare(`${GAME_COLUMNS} WHERE g.status = ? ORDER BY g.id DESC`).all(GAME_OPEN);
}

/**
 * The caller's own live game — open or playing — or null. Newest first, because that is
 * the one a player means by "my game" if they somehow have more than one.
 */
function findLiveGameForUser(db, userId) {
  return db.prepare(
    `${GAME_COLUMNS} WHERE g.status IN (?, ?) AND (g.host_id = ? OR g.guest_id = ?) ORDER BY g.id DESC LIMIT 1`
  ).get(GAME_OPEN, GAME_PLAYING, userId, userId) || null;
}

/** A game this player is hosting and nobody has joined yet, or null. */
function findOpenGameHostedBy(db, userId) {
  return db.prepare(`${GAME_COLUMNS} WHERE g.host_id = ? AND g.status = ? LIMIT 1`).get(userId, GAME_OPEN) || null;
}

function insertGame(db, game) {
  const info = db.prepare(
    `INSERT INTO games (seed, host_id, guest_id, status, created_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(game.seed, game.hostId, game.guestId, game.status, game.createdAt, game.startedAt);
  return Number(info.lastInsertRowid);
}

/**
 * Fill the empty seat, returning whether this call is the one that got it.
 *
 * `status = 'open'` in the WHERE clause is the entire concurrency control: two players
 * racing for one game both run this UPDATE, exactly one changes a row, and the other is
 * told the game is gone rather than quietly becoming its second guest.
 */
function claimGame(db, id, guestId, seed, startedAt) {
  const info = db.prepare(
    `UPDATE games SET guest_id = ?, seed = ?, status = ?, started_at = ?
      WHERE id = ? AND status = ?`
  ).run(guestId, seed, GAME_PLAYING, startedAt, id, GAME_OPEN);
  return Number(info.changes) === 1;
}

function deleteGame(db, id) {
  return Number(db.prepare('DELETE FROM games WHERE id = ?').run(id).changes);
}

/** Cancel whatever this player is hosting that nobody has joined. Returns how many. */
function deleteOpenGamesHostedBy(db, userId) {
  return Number(db.prepare('DELETE FROM games WHERE host_id = ? AND status = ?').run(userId, GAME_OPEN).changes);
}

/**
 * Games that have been sitting around since before `cutoff`, for the lobby's sweep.
 *
 * A playing game is filtered by when it *started* and an open one by when it was created,
 * so both mean "nobody has touched this for a while". The caller still has to check
 * whether anybody is connected: this is the half that storage can answer.
 */
function listStaleGames(db, cutoff) {
  return db.prepare(
    `SELECT id, host_id, guest_id FROM games
      WHERE (status = ? AND created_at <= ?) OR (status = ? AND started_at <= ?)`
  ).all(GAME_OPEN, cutoff, GAME_PLAYING, cutoff);
}

function deleteGames(db, ids) {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  return Number(db.prepare(`DELETE FROM games WHERE id IN (${placeholders})`).run(...ids).changes);
}

/**
 * A player's live matches. Used by the presence bookkeeping, which has to tell the
 * opponent of somebody who just went away — plural because a player is not stopped from
 * being in more than one playing game, and one presence change concerns all of them.
 */
function listPlayingGamesForUser(db, userId) {
  return db.prepare(`${GAME_COLUMNS} WHERE g.status = ? AND (g.host_id = ? OR g.guest_id = ?)`)
    .all(GAME_PLAYING, userId, userId);
}

/**
 * End a match, returning whether this call is the one that ended it.
 *
 * `status = 'playing'` in the WHERE clause is the concurrency control, the same shape as
 * claimGame's: the two clients report their results independently, both calls run this
 * UPDATE, and exactly one of them is told it was the one that finished the match — so a
 * client can never be told twice, and a finished match can never be re-finished with a
 * different winner by a late report.
 */
function finishGame(db, id, winnerId, finishedAt, desync) {
  const info = db.prepare(
    `UPDATE games SET status = ?, winner_id = ?, finished_at = ?, desync = ?
      WHERE id = ? AND status = ?`
  ).run(GAME_FINISHED, winnerId, finishedAt, desync ? 1 : 0, id, GAME_PLAYING);
  return Number(info.changes) === 1;
}

// ---------------------------------------------------------------------- shots

/**
 * Append a shot to a game's replay log, returning null when that turn already has one.
 *
 * The UNIQUE index on (game_id, turn) is the authority on "once per turn", not a SELECT
 * first: two requests from the same player for the same turn is the case this exists for,
 * and a read-then-write would let both of them find the turn free.
 */
function insertShot(db, shot) {
  try {
    const info = db.prepare(
      `INSERT INTO shots (game_id, turn, user_id, angle, power, state_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(shot.gameId, shot.turn, shot.userId, shot.angle, shot.power, shot.stateHash, shot.createdAt);
    return Number(info.lastInsertRowid);
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/** A game's shots in turn order — the order they have to be replayed in. */
function listShots(db, gameId) {
  return db.prepare(
    'SELECT turn, user_id, angle, power, state_hash, created_at FROM shots WHERE game_id = ? ORDER BY turn ASC'
  ).all(gameId);
}

/**
 * The public shape of a shot. `userId` rather than a name, unlike a player in a game:
 * both players are already named once in the payload, and a shot is the same row to both
 * of them.
 */
function toPublicShot(row) {
  return {
    turn: Number(row.turn),
    userId: Number(row.user_id),
    angle: Number(row.angle),
    power: Number(row.power),
    stateHash: String(row.state_hash),
    createdAt: Number(row.created_at)
  };
}

// ------------------------------------------------------------------- messages

function insertMessage(db, message) {
  const info = db.prepare(
    'INSERT INTO messages (game_id, user_id, body, created_at) VALUES (?, ?, ?, ?)'
  ).run(message.gameId, message.userId, message.body, message.createdAt);
  return Number(info.lastInsertRowid);
}

/** Oldest first, which is the order a chat log is read in. */
function listMessages(db, gameId) {
  return db.prepare(
    'SELECT user_id, body, created_at FROM messages WHERE game_id = ? ORDER BY id ASC'
  ).all(gameId);
}

/** `text` rather than `body`, so the wire shape reads as prose rather than as a column. */
function toPublicMessage(row) {
  return { userId: Number(row.user_id), text: String(row.body), createdAt: Number(row.created_at) };
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
  findUserById,
  toPublicUser,
  toPublicPlayer,
  displayNameFor,
  insertSession,
  findSessionUser,
  deleteSession,
  deleteExpiredSessions,
  isUniqueViolation,
  GAME_OPEN,
  GAME_PLAYING,
  GAME_FINISHED,
  toPublicGame,
  activeUserIdFor,
  findGameById,
  listOpenGames,
  findLiveGameForUser,
  findOpenGameHostedBy,
  insertGame,
  claimGame,
  deleteGame,
  deleteOpenGamesHostedBy,
  listStaleGames,
  listPlayingGamesForUser,
  finishGame,
  deleteGames,
  insertShot,
  listShots,
  toPublicShot,
  insertMessage,
  listMessages,
  toPublicMessage
};
