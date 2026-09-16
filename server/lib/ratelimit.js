/**
 * ratelimit.js — a fixed-window counter per bucket, keyed by whoever the caller says.
 *
 * In-memory and per-process, on purpose: there is one process, one client-facing port,
 * and no shared store available to reach for without a dependency. The trade-offs are
 * that a restart clears every counter and a second replica would keep its own — both
 * acceptable for a game server whose worst case is a spammed table of accounts, and
 * both cheaper than the alternative.
 *
 * The window is fixed rather than sliding: the worst case is a client sending `max` at
 * the end of one window and `max` at the start of the next, which for a login endpoint
 * is not a meaningful difference.
 *
 * The key is the caller's choice because the two kinds of limit answer two different
 * questions. An endpoint that anybody can reach is limited per address — that is the
 * only identity available before a session exists. An endpoint inside a match is limited
 * per *player*, because what it bounds is one player flooding a room, and one address is
 * not one player: a shared connection would otherwise make two players share a budget
 * and let one of them spend it for both.
 */
'use strict';

// The counter map is keyed by client address, which an attacker in part controls, so it
// needs a ceiling: past this many live keys, expired entries are dropped wholesale.
const SWEEP_THRESHOLD = 1024;

/**
 * @param {{max: number, windowMs: number}} options
 * @returns {{check(key: string, now?: number): {allowed: boolean, retryAfterSeconds: number}, size: number}}
 */
function createBucket({ max, windowMs }) {
  const hits = new Map();

  function sweep(now) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }

  return {
    /**
     * Record an attempt and say whether it may proceed. `max` attempts are allowed per
     * window; the next one is refused, as are the rest of that window's.
     */
    check(key, now = Date.now()) {
      if (hits.size > SWEEP_THRESHOLD) sweep(now);

      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      entry.count += 1;
      if (entry.count > max) {
        // Retry-After has to be at least a second: rounding down to 0 would tell a
        // client to retry immediately, which is the opposite of the intent.
        const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        return { allowed: false, retryAfterSeconds };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },

    get size() {
      return hits.size;
    }
  };
}

/** One bucket per limited endpoint. Separate buckets so register spam cannot lock out login. */
function createLimiters(rateLimit) {
  return {
    login: createBucket(rateLimit.login),
    register: createBucket(rateLimit.register),
    games: createBucket(rateLimit.games),
    queue: createBucket(rateLimit.queue),
    shots: createBucket(rateLimit.shots),
    chat: createBucket(rateLimit.chat)
  };
}

module.exports = { createBucket, createLimiters };
