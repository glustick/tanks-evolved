/**
 * lobby.js — the realtime half: who is connected, who is waiting, and who just got
 * matched.
 *
 * Two kinds of state live here, and they are kept apart on purpose.
 *
 * Games are rows in SQLite, because a game outlives a connection: a player whose browser
 * reloads mid-match must find their game still there.
 *
 * Streams and the quick-match queue are in memory, because they *are* connections. A
 * queue entry means "I am sitting here waiting for an opponent", and an opponent has to
 * be told — which takes a live stream. Nothing is lost by that: a restart clears the
 * queue, and everybody waiting in it learns the moment their stream drops and retries.
 * Storing the queue would only create rows that have to be swept and can be stale.
 *
 * The cleanup story, since a dropped connection must not strand anyone:
 *   - a player's queue entry goes when their last stream closes, because waiting is
 *     meaningless without a way to be told;
 *   - an open game they host goes with it, because an open game is the same kind of
 *     claim ("I am here, waiting for an opponent") and the lobby would otherwise list a
 *     host who has no tab open;
 *   - a *playing* game is left alone. A refresh, or a train tunnel, must not concede a
 *     match — so those are instead swept once nobody in them has been connected for
 *     longer than `abandonMs` (see sweep()).
 * Both disconnects are delayed by a grace period. EventSource reconnects on its own
 * after a few seconds, and a reconnecting player should not lose their place.
 */
'use strict';

const crypto = require('node:crypto');
const { openEventStream, writeEvent, writeComment, httpError } = require('./http');
const storage = require('./db');
const logger = require('./logger');

/**
 * Seeds are words and a number, like the ones the client suggests, because they are
 * shown to both players and typed into the seed box when a match is replayed locally.
 * From crypto.randomInt rather than Math.random: this decides a shared map, and the one
 * player who could predict it is the one who benefits.
 */
const SEED_WORDS = [
  'EAGLE', 'RAVEN', 'COBRA', 'OUTLAW', 'BISON', 'MIRAGE', 'VULCAN', 'NOMAD',
  'SABRE', 'DRIFTER', 'HYENA', 'KESTREL', 'ONYX', 'ZEPHYR', 'GRANITE', 'PILOT'
];

/** The one format the client's own seed box would produce, so both ends accept it. */
function makeSeed() {
  const word = SEED_WORDS[crypto.randomInt(SEED_WORDS.length)];
  return `${word}-${crypto.randomInt(1000, 10000)}`;
}

/**
 * @param {{config: object, database: object, now?: () => number}} deps
 * @returns {object} the hub: streams, the queue, and the broadcasts both are for
 */
function createLobby({ config, database, now = Date.now }) {
  /**
   * userId -> { player, sockets }. The player is looked up once per connection and
   * reused for every broadcast, so a lobby change costs one query per *connection*, not
   * one per player per event.
   */
  const streams = new Map();
  /** userId -> the time they started waiting. Insertion order is the queue's order. */
  const waiting = new Map();
  /** userId -> the pending post-disconnect cleanup, so a reconnect can cancel it. */
  const cleanupTimers = new Map();
  let closed = false;

  // ------------------------------------------------------------------- streams

  /** How many event streams this process is holding open. Reported in the log. */
  function streamCount() {
    let total = 0;
    for (const entry of streams.values()) total += entry.sockets.size;
    return total;
  }

  /** The human-readable side of a stream: one line per connect and per disconnect. */
  function logStream(event, userId) {
    logger.info(`stream ${event} user=${userId} streams=${streamCount()}`);
  }

  /**
   * Send one event to every tab a player has open. Returns how many got it, which is
   * also how "is this player actually listening" is answered.
   */
  function send(userId, event, data) {
    const entry = streams.get(userId);
    if (!entry) return 0;
    let sent = 0;
    for (const socket of entry.sockets) {
      if (writeEvent(socket, event, data)) sent++;
    }
    return sent;
  }

  /**
   * The lobby as one player sees it.
   *
   * `shared` is the half that is identical for everybody (the open games and the queue
   * depth), computed once per broadcast and handed in; only `you` differs. A caller with
   * no stream open — a plain GET /api/lobby — passes nothing and pays one extra lookup
   * for its own display name.
   */
  function payload(userId, shared) {
    const entry = streams.get(userId);
    const sharedPart = shared || {
      games: storage.listOpenGames(database).map(storage.toPublicGame),
      queue: { count: waiting.size }
    };
    const own = storage.findLiveGameForUser(database, userId);
    const player = entry ? entry.player : storage.findUserById(database, userId);

    return {
      games: sharedPart.games,
      queue: sharedPart.queue,
      you: {
        // Another player's payload never contains this: it is built per user, and
        // toPublicPlayer carries an id and a name and nothing else.
        player: storage.toPublicPlayer(player),
        waiting: waiting.has(userId),
        game: own === null ? null : storage.toPublicGame(own)
      }
    };
  }

  /**
   * Tell everybody who is listening that the lobby changed.
   *
   * The keys are copied before the loop: writing to a socket can close it, and a
   * disconnect that lands mid-iteration would otherwise mutate the map being walked.
   */
  function broadcastLobby() {
    if (closed) return;
    const shared = {
      games: storage.listOpenGames(database).map(storage.toPublicGame),
      queue: { count: waiting.size }
    };
    for (const userId of [...streams.keys()]) {
      send(userId, 'lobby', payload(userId, shared));
    }
  }

  /** Tell both players they are in a game. The one event that is not a lobby change. */
  function notifyMatch(game) {
    if (closed) return;
    send(game.host.id, 'match', { game });
    if (game.guest) send(game.guest.id, 'match', { game });
  }

  /**
   * Attach an SSE stream for one player.
   *
   * A reconnect cancels the pending cleanup rather than racing it, which is why the
   * timer exists at all: a dropped stream should not cost a player their place.
   */
  function openStream(res, user) {
    const existing = streams.get(user.id);
    if (existing && existing.sockets.size >= config.maxStreamsPerUser) {
      // Refused before anything is written, so the answer is an ordinary JSON error the
      // client can log and stop on. Answering 503 rather than closing an old stream is
      // deliberate: a browser treats a non-200 stream as final and stops, while a closed
      // stream is retried — which would turn this limit into a reconnect loop.
      logger.warn(`refusing a stream for user ${user.id}: already at ${existing.sockets.size}`);
      throw httpError(503, 'too_many_streams',
        `at most ${config.maxStreamsPerUser} live connections per player`, { 'Retry-After': '5' });
    }

    cancelCleanup(user.id);

    openEventStream(res);
    let entry = existing;
    if (!entry) {
      entry = { player: storage.findUserById(database, user.id), sockets: new Set() };
      streams.set(user.id, entry);
    }
    entry.sockets.add(res);
    logStream('open', user.id);

    // hello first, and with the same body type as every later `lobby`, so a client has
    // one render path: a tab that reconnects repaints from this and is up to date.
    writeEvent(res, 'hello', payload(user.id));

    res.on('close', () => {
      entry.sockets.delete(res);
      if (entry.sockets.size === 0) streams.delete(user.id);
      logStream('close', user.id);
      scheduleCleanup(user.id);
    });

    return res;
  }

  // -------------------------------------------------------------------- queue

  function addWaiter(userId) {
    if (!waiting.has(userId)) waiting.set(userId, now());
  }

  /** Stop waiting. Returns whether there was anything to stop. */
  function removeWaiter(userId) {
    return waiting.delete(userId);
  }

  function isWaiting(userId) {
    return waiting.has(userId);
  }

  function waiterCount() {
    return waiting.size;
  }

  /**
   * Take the longest-waiting player out of the queue and return their id, or null.
   *
   * A Map iterates in insertion order, so "first in, first served" is the data
   * structure's own behaviour rather than something to maintain. The caller excludes
   * itself: taking your own queue entry would pair you with yourself.
   */
  function takeWaiter(exceptUserId) {
    for (const userId of waiting.keys()) {
      if (userId === exceptUserId) continue;
      waiting.delete(userId);
      return userId;
    }
    return null;
  }

  // ---------------------------------------------------------------- disconnect

  /**
   * Start the countdown for a player who has just lost their last stream.
   *
   * Unref'd: a pending cleanup is not a reason for the process to stay alive, and on the
   * way out close() clears it anyway.
   */
  function scheduleCleanup(userId) {
    if (closed || cleanupTimers.has(userId)) return;
    const timer = setTimeout(() => runCleanup(userId), config.streamGraceMs);
    timer.unref();
    cleanupTimers.set(userId, timer);
  }

  function cancelCleanup(userId) {
    const timer = cleanupTimers.get(userId);
    if (!timer) return;
    clearTimeout(timer);
    cleanupTimers.delete(userId);
  }

  /**
   * A player is gone: give up their place in the queue and cancel what they were
   * hosting. See the module header for why a playing game is left standing.
   */
  function runCleanup(userId) {
    cleanupTimers.delete(userId);
    if (closed || streams.has(userId)) return;

    const leftQueue = waiting.delete(userId);
    const cancelled = storage.deleteOpenGamesHostedBy(database, userId);
    if (leftQueue || cancelled > 0) {
      logger.info(`stream gone: user=${userId} dropped from the queue=${leftQueue} open games cancelled=${cancelled}`);
      broadcastLobby();
    }
  }

  // ------------------------------------------------------------------- sweeps

  /**
   * Drop games nobody has been connected to for `abandonMs`.
   *
   * A playing game survives a disconnect on purpose, which means the only thing that
   * ends one in Phase 2 is this: without it, two players who closed their tabs would
   * leave a row that the lobby considers live — and, worse, a game that blocks whichever
   * of them comes back. Runs on the keepalive tick, so it costs one small query and no
   * timer of its own.
   */
  function sweep() {
    const stale = storage.listStaleGames(database, now() - config.abandonMs);
    if (stale.length === 0) return 0;

    const abandoned = stale.filter((row) => !streams.has(Number(row.host_id)) && !streams.has(Number(row.guest_id)));
    if (abandoned.length === 0) return 0;

    const removed = storage.deleteGames(database, abandoned.map((row) => Number(row.id)));
    if (removed > 0) {
      logger.info(`swept ${removed} abandoned game${removed === 1 ? '' : 's'}`);
      broadcastLobby();
    }
    return removed;
  }

  // ------------------------------------------------------------------ ticking

  /**
   * The keepalive: a comment line down every open stream, often enough that an idle proxy
   * never decides the connection is dead. Invisible to the client's event handlers.
   */
  const keepalive = setInterval(() => {
    for (const entry of streams.values()) {
      for (const socket of entry.sockets) writeComment(socket, 'keepalive');
    }
  }, config.streamKeepaliveMs);

  // The sweep runs on its own clock rather than on the keepalive's: how often an idle
  // connection needs a byte is a question about proxies, and how often to look for
  // abandoned games is a question about the lobby. They only happen to be periodic.
  const sweeper = setInterval(sweep, config.sweepMs);

  // Neither is a reason to keep the process up: shutdown clears them explicitly.
  keepalive.unref();
  sweeper.unref();

  /**
   * End every stream and stop the timers. Called on the way down, before the server stops
   * accepting: server.close() waits for in-flight requests, and an event stream is one
   * that would never finish on its own — so a shutdown would otherwise sit out its whole
   * grace period waiting for connections this process can simply close.
   */
  function close() {
    closed = true;
    clearInterval(keepalive);
    clearInterval(sweeper);
    for (const userId of [...cleanupTimers.keys()]) cancelCleanup(userId);

    // The sockets are ended, not evicted from the map: each one's own 'close' handler
    // then reports the count it actually saw, which is the only version of that line
    // worth having in a log read after the fact.
    const sockets = [];
    for (const entry of streams.values()) sockets.push(...entry.sockets);
    for (const socket of sockets) socket.end();

    // Nothing can be waiting once nobody is connected, and no cleanup timer is left to
    // say so.
    waiting.clear();
  }

  return {
    openStream,
    send,
    payload,
    broadcastLobby,
    notifyMatch,
    addWaiter,
    removeWaiter,
    isWaiting,
    waiterCount,
    takeWaiter,
    sweep,
    close,
    streamCount
  };
}

module.exports = { createLobby, makeSeed, SEED_WORDS };
