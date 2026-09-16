/**
 * logger.js — one line per request, plus the errors that never leave the process.
 *
 * Deliberately not a logging library: there are two shapes here, both go to the
 * container's own streams, and `docker logs` is the whole story. What matters is what
 * is *absent* from these lines — no bodies, no headers, no cookies, no tokens, and no
 * query strings, because a query string is somewhere a secret can hide and nothing in
 * this server reads one.
 */
'use strict';

/** UTC and marked as such: a server log without a zone is a debugging trap. */
function stamp(now = new Date()) {
  return now.toISOString();
}

/** The access line. Intentionally the whole of it: method, path, status, duration, peer. */
function request(method, pathname, status, durationMs, remote) {
  process.stdout.write(`${stamp()} ${method} ${pathname} ${status} ${durationMs.toFixed(1)}ms ${remote}\n`);
}

function info(message) {
  process.stdout.write(`${stamp()} ${message}\n`);
}

function warn(message) {
  process.stderr.write(`${stamp()} WARN ${message}\n`);
}

/**
 * Server-side only. The stack stays here — a client is never sent one, but the
 * operator needs it, and this is the only place it is allowed to appear.
 */
function error(message, err) {
  const detail = err && err.stack ? err.stack : (err && err.message) || '';
  process.stderr.write(`${stamp()} ERROR ${message}${detail ? ` — ${detail}` : ''}\n`);
}

module.exports = { request, info, warn, error };
