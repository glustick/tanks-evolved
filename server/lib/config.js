/**
 * config.js — every environment variable this server reads, in one place.
 *
 * There is no config file and no schema to validate one against: the server takes
 * plain environment variables, each with a working default, so `node server/index.js`
 * runs with nothing set. Keeping them together means the defaults, the parsing and
 * the "what happens if this is garbage" behaviour can be read in one sitting.
 */
'use strict';

const path = require('node:path');

// server/lib/../.. is the repository root. Relative paths from the environment are
// resolved against it rather than process.cwd(), so the same command works from the
// repo root, from server/, and from the container's WORKDIR.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const MINUTE = 60 * 1000;

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8081,
  dbFile: path.join(REPO_ROOT, 'server', 'data', 'tanks.db'),
  secureCookies: false,
  sessionTtlMs: 30 * 24 * 60 * MINUTE,
  // The request bodies here are an email and a password. 8 KiB is generous for that
  // and small enough that a hostile client cannot make the process hold anything
  // interesting.
  bodyLimitBytes: 8 * 1024,
  transportTimeoutMs: 30 * 1000,
  // Per client IP, fixed window. Login gets the larger budget because a player
  // mistyping a password is the ordinary case worth not breaking; register is the one
  // an attacker would automate to fill the disk with accounts, so it is the tighter
  // of the two.
  loginMax: 10,
  loginWindowMs: 5 * MINUTE,
  registerMax: 5,
  registerWindowMs: 60 * MINUTE,
  // Hosting is the same kind of write as registering — a row an anonymous client asked
  // for — but a player hosts and cancels repeatedly while they wait for a friend, so the
  // budget is per ten minutes rather than per hour. Queueing is cheaper still and toggled
  // more (waiting for an opponent is exactly when someone changes their mind).
  gamesMax: 20,
  gamesWindowMs: 10 * MINUTE,
  queueMax: 30,
  queueWindowMs: 5 * MINUTE,
  // The SSE keepalive. Short enough that an idle proxy does not close a quiet stream
  // (nginx's proxy_read_timeout defaults to 60s), long enough to be free: the same tick
  // also sweeps abandoned games.
  streamKeepaliveMs: 20 * 1000,
  // How long a player's queue entry and hosted game survive their last stream closing.
  // EventSource retries on its own after a few seconds, and a reconnect must not cost
  // anybody their place.
  streamGraceMs: 15 * 1000,
  // How long a game may sit with nobody connected before it is swept. A losing network
  // connection must not end a match, so this is minutes rather than seconds — and the
  // sweep runs often enough to act on it promptly, which is a separate number because
  // the two answer different questions.
  abandonMs: 30 * MINUTE,
  sweepMs: 60 * 1000,
  // An event stream is a socket held open until the browser goes away, and a browser can
  // open as many as it likes. This is what stops one account from holding the process's
  // file descriptors: eight is more tabs than anybody plays with, and fewer than a
  // hostile client would want.
  maxStreamsPerUser: 8
};

/**
 * Integer environment variable, or the default when absent or unusable.
 * Records a warning instead of silently substituting, so a typo shows up in the boot
 * log rather than as behaviour nobody can explain later.
 */
function integer(env, name, fallback, min, max, warnings) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    warnings.push(`${name}=${JSON.stringify(raw)} is not an integer in [${min}, ${max}] — using ${fallback}`);
    return fallback;
  }
  return value;
}

/** Only the two documented spellings turn a switch on; anything else is the default. */
function flag(env, name, fallback, warnings) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  warnings.push(`${name}=${JSON.stringify(raw)} is not a boolean — using ${fallback}`);
  return fallback;
}

/**
 * Build the runtime configuration.
 * @param {NodeJS.ProcessEnv} env
 * @returns {object} config, plus `warnings` for the caller to log once at boot
 */
function loadConfig(env = process.env) {
  const warnings = [];
  const dbRaw = env.TANKS_DB;

  return {
    repoRoot: REPO_ROOT,
    host: env.HOST || DEFAULTS.host,
    // 0 is a valid port and means "any free one" — the test suite relies on it, so it
    // must survive the range check that rejects nonsense.
    port: integer(env, 'PORT', DEFAULTS.port, 0, 65535, warnings),
    dbFile: dbRaw ? path.resolve(REPO_ROOT, dbRaw) : DEFAULTS.dbFile,
    // Off by default because the default deployment is plain HTTP on a LAN or behind
    // a private network; with it on, a browser would drop the cookie on a http:// URL
    // and nobody could log in.
    secureCookies: flag(env, 'TANKS_SECURE_COOKIES', DEFAULTS.secureCookies, warnings),
    sessionTtlMs: integer(env, 'TANKS_SESSION_TTL_MS', DEFAULTS.sessionTtlMs, MINUTE, 365 * 24 * 60 * MINUTE, warnings),
    bodyLimitBytes: integer(env, 'TANKS_BODY_LIMIT_BYTES', DEFAULTS.bodyLimitBytes, 128, 1024 * 1024, warnings),
    transportTimeoutMs: integer(env, 'TANKS_TIMEOUT_MS', DEFAULTS.transportTimeoutMs, 1000, 10 * MINUTE, warnings),
    rateLimit: {
      login: {
        max: integer(env, 'TANKS_LOGIN_MAX', DEFAULTS.loginMax, 1, 10000, warnings),
        windowMs: integer(env, 'TANKS_LOGIN_WINDOW_MS', DEFAULTS.loginWindowMs, 1000, 24 * 60 * MINUTE, warnings)
      },
      register: {
        max: integer(env, 'TANKS_REGISTER_MAX', DEFAULTS.registerMax, 1, 10000, warnings),
        windowMs: integer(env, 'TANKS_REGISTER_WINDOW_MS', DEFAULTS.registerWindowMs, 1000, 24 * 60 * MINUTE, warnings)
      },
      games: {
        max: integer(env, 'TANKS_GAMES_MAX', DEFAULTS.gamesMax, 1, 10000, warnings),
        windowMs: integer(env, 'TANKS_GAMES_WINDOW_MS', DEFAULTS.gamesWindowMs, 1000, 24 * 60 * MINUTE, warnings)
      },
      queue: {
        max: integer(env, 'TANKS_QUEUE_MAX', DEFAULTS.queueMax, 1, 10000, warnings),
        windowMs: integer(env, 'TANKS_QUEUE_WINDOW_MS', DEFAULTS.queueWindowMs, 1000, 24 * 60 * MINUTE, warnings)
      }
    },
    streamKeepaliveMs: integer(env, 'TANKS_STREAM_KEEPALIVE_MS', DEFAULTS.streamKeepaliveMs, 1000, 10 * MINUTE, warnings),
    streamGraceMs: integer(env, 'TANKS_STREAM_GRACE_MS', DEFAULTS.streamGraceMs, 0, 10 * MINUTE, warnings),
    abandonMs: integer(env, 'TANKS_ABANDON_MS', DEFAULTS.abandonMs, 1000, 24 * 60 * MINUTE, warnings),
    sweepMs: integer(env, 'TANKS_SWEEP_MS', DEFAULTS.sweepMs, 100, 60 * MINUTE, warnings),
    maxStreamsPerUser: integer(env, 'TANKS_MAX_STREAMS_PER_USER', DEFAULTS.maxStreamsPerUser, 1, 1024, warnings),
    warnings
  };
}

module.exports = { loadConfig, REPO_ROOT, DEFAULTS };
