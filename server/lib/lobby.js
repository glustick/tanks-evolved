/**
 * lobby.js — the realtime half: who is connected, who is waiting, who just got matched,
 * and what is happening in the matches those players are in.
 *
 * Two kinds of state live here, and they are kept apart on purpose.
 *
 * Games are rows in SQLite, because a game outlives a connection: a player whose browser
 * reloads mid-match must find their game still there, with the shots already played in
 * it.
 *
 * Streams, the quick-match queue and the two pending-report tables are in memory, because
 * they *are* connections. A queue entry means "I am sitting here waiting for an
 * opponent", and an opponent has to be told — which takes a live stream. A pending result
 * is the same kind of thing: it is one client's answer to "who won", meaningful only
 * until the other client answers, seconds later. Storing either would create rows that
 * have to be swept. What a restart costs is one more report from a client that is still
 * looking at the finished board, which is why the client re-sends rather than assuming its
 * report landed.
 *
 * The cleanup story, since a dropped connection must not strand anyone:
 *   - a player's queue entry goes when their last stream closes, because waiting is
 *     meaningless without a way to be told;
 *   - an open game they host goes with it, because an open game is the same kind of
 *     claim ("I am here, waiting for an opponent") and the lobby would otherwise list a
 *     host who has no tab open;
 *   - a *playing* game is left alone. A refresh, or a train tunnel, must not concede a
 *     match — so the player is marked away, their opponent is told, and the match is
 *     swept as a walkover only once they have been gone longer than `abandonMs`.
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
  /**
   * userId -> when they were last seen to be gone, for players who are in a match. The
   * clock this starts is what ends a match whose player never came back (see sweep()).
   */
  const awaySince = new Map();
  /**
   * gameId -> userId -> that player's result report. In memory, and in one map rather than
   * a table, because a report is only meaningful until the other one arrives — see the
   * module header.
   */
  const reports = new Map();
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

  // -------------------------------------------------------------------- matches

  /** The two players of a game, in seat order, with the empty seat dropped. */
  function participantsOf(game) {
    return game.guest === null ? [game.host.id] : [game.host.id, game.guest.id];
  }

  /**
   * Everything a client needs about one match, as one object.
   *
   * This is the only shape a match is ever described in, and it is deliberately the whole
   * of it — the game, the replay log, the chat, whose turn it is and who is connected.
   * Every route and every event goes through here, so a client that has fallen behind
   * (a reload, a dropped stream, a missed event) can rebuild itself from any single copy
   * of it rather than by accumulating deltas and hoping none were lost.
   *
   * Returns null for a game that is no longer there, so a caller that raced the sweep
   * sends nothing rather than throwing.
   */
  function gameState(gameId) {
    const row = storage.findGameById(database, gameId);
    if (row === null) return null;

    const game = storage.toPublicGame(row);
    const shots = storage.listShots(database, gameId).map(storage.toPublicShot);
    const turn = shots.length + 1;

    return {
      game,
      shots,
      messages: storage.listMessages(database, gameId).map(storage.toPublicMessage),
      // 1-based, and always one past the last shot played: both clients derive the same
      // number from the log they are replaying, so it is not a second source of truth.
      turn,
      // Whose turn it is by the server's reckoning — the authority the clients follow
      // rather than their own guess. Null once the match is over.
      activeUserId: game.status === storage.GAME_PLAYING ? storage.activeUserIdFor(game, turn) : null,
      // Presence is per seat rather than per id because that is how the client thinks
      // about the two players; true means a stream is open right now.
      presence: {
        host: streams.has(game.host.id),
        guest: game.guest !== null && streams.has(game.guest.id)
      }
    };
  }

  /** Push the whole match to both players. The event a client resyncs from. */
  function broadcastGameState(gameId) {
    if (closed) return;
    const state = gameState(gameId);
    if (state === null) return;
    for (const userId of participantsOf(state.game)) send(userId, 'game', state);
  }

  /**
   * Tell both players they are in a game. The one event that is not a lobby change.
   */
  function notifyMatch(game) {
    if (closed) return;
    const state = gameState(game.id);
    if (state === null) return;
    for (const userId of participantsOf(game)) send(userId, 'match', state);
  }

  /**
   * A shot has been played: relay it, then say whose turn it now is.
   *
   * Both events go to both players, including the one who fired. Applying a shot is the
   * same piece of work whoever played it, and the shooter's own board must run the same
   * code path as the opponent's — that is what keeps the two boards identical rather than
   * merely similar.
   */
  function notifyShot(gameId, shot) {
    if (closed) return;
    const state = gameState(gameId);
    if (state === null) return;
    for (const userId of participantsOf(state.game)) {
      send(userId, 'shot', { shot });
      send(userId, 'turn', { turn: state.turn, activeUserId: state.activeUserId });
      send(userId, 'game', state);
    }
  }

  /**
   * A chat message. Only the message: the rest of the match has not changed, and the
   * log is in the game payload for whoever needs the history rather than the news.
   */
  function notifyChat(gameId, message) {
    if (closed) return;
    const state = gameState(gameId);
    if (state === null) return;
    for (const userId of participantsOf(state.game)) send(userId, 'chat', { message });
  }

  /**
   * The match is over: a result both players agreed on, or a disagreement.
   *
   * A desync is its own event because it is not a victory and must not be rendered as
   * one, and both the event and the game payload carry the reason so a client can say
   * what happened without having to infer it.
   */
  function notifyOver(gameId, reason) {
    if (closed) return;
    const state = gameState(gameId);
    if (state === null) return;
    // Every ending goes through here, so this is where the two reports stop being needed:
    // keeping them would leave a map entry per match for the life of the process.
    reports.delete(gameId);
    const event = reason === 'desync' ? 'desync' : 'over';
    for (const userId of participantsOf(state.game)) {
      send(userId, event, Object.assign({ reason }, state));
    }
    broadcastGameState(gameId);
    // A finished game is no longer a live one, so `you.game` has just gone null for both
    // players and every open lobby is now out of date.
    broadcastLobby();
  }

  /** One player's stream came and went: the other one is told, and both see the panel. */
  function notifyOpponent(game, userId, present) {
    if (closed) return;
    for (const otherId of participantsOf(game)) {
      if (otherId === userId) continue;
      send(otherId, 'opponent', { userId, present });
    }
  }

  /**
   * Record one player's result report and say what it means.
   *
   * The two clients are the only source of "who won": the server never simulated, so it
   * cannot check a result, only compare the two accounts of it. That is why both are
   * required and why a disagreement is a desync rather than a decision.
   *
   * A player repeating their own report is not an error — a client that never saw its
   * response re-sends it — but a player *changing* their report would make "both agree"
   * meaningless, so that is refused instead.
   *
   * @returns {{status: 'waiting'|'agreed'|'desync'|'repeat'|'conflict', winnerId?: number|null}}
   */
  function recordResult(gameId, userId, report) {
    let entry = reports.get(gameId);
    if (!entry) {
      entry = new Map();
      reports.set(gameId, entry);
    }

    const previous = entry.get(userId);
    if (previous) {
      const same = previous.winnerId === report.winnerId && previous.stateHash === report.stateHash;
      return { status: same ? 'repeat' : 'conflict' };
    }

    entry.set(userId, report);
    if (entry.size < 2) return { status: 'waiting' };

    const [first, second] = [...entry.values()];
    // The winner *and* the board. Two clients can agree on a name and still be looking at
    // two different worlds, and the hash is the only thing either of them said that is
    // about the world rather than about the game.
    const agree = first.winnerId === second.winnerId && first.stateHash === second.stateHash;
    return agree ? { status: 'agreed', winnerId: first.winnerId } : { status: 'desync' };
  }

  /** Forget a game's reports once it has ended, so the map does not grow forever. */
  function forgetResult(gameId) {
    reports.delete(gameId);
  }

  /**
   * Mark a player away and tell their opponents.
   *
   * Called once the grace period has passed with no stream, never on the drop itself: a
   * tab that is reloading is not a player who has left, and telling the opponent "away"
   * for the second and a half an EventSource takes to come back would make the indicator
   * useless.
   */
  function markAway(userId) {
    const playing = storage.listPlayingGamesForUser(database, userId);
    if (playing.length === 0) return;

    awaySince.set(userId, now());
    for (const row of playing) {
      const game = storage.toPublicGame(row);
      logger.info(`player ${userId} is away in game ${game.id}`);
      notifyOpponent(game, userId, false);
      broadcastGameState(game.id);
    }
  }

  /** The same, in reverse, from the moment a stream for that player is accepted. */
  function markPresent(userId) {
    if (!awaySince.delete(userId)) return;
    for (const row of storage.listPlayingGamesForUser(database, userId)) {
      const game = storage.toPublicGame(row);
      logger.info(`player ${userId} is back in game ${game.id}`);
      notifyOpponent(game, userId, true);
      broadcastGameState(game.id);
    }
  }

  /**
   * Tell both players they are in a game. The one event that is not a lobby change.
   */
  function notifyMatch(game) {
    if (closed) return;
    const state = gameState(game.id);
    if (state === null) return;
    for (const userId of participantsOf(game)) send(userId, 'match', state);
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

    // Then the other direction: anybody waiting on this player's move is told they are
    // back. After hello, so the returning player's own board is current before the
    // opponent's shell — relayed next, at the opponent's convenience — arrives.
    markPresent(user.id);

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
   * A player is gone: give up their place in the queue, cancel what they were hosting,
   * and mark them away in whatever match they are in. See the module header for why a
   * playing game is left standing.
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
    markAway(userId);
  }

  // ------------------------------------------------------------------- sweeps

  /**
   * End the matches of players who never came back.
   *
   * A match survives a disconnect on purpose, so something has to be able to end one that
   * nobody returns to. This is that something, and it is a *walkover* rather than a
   * timeout: it is only applied while the other player is still connected and still
   * waiting, so the result is one of the two players winning by staying rather than
   * neither of them winning because the server got bored. Nobody's client has to invent
   * a terminal state, which is the whole point — a result reported by a client that is
   * no longer there could never be agreed on by both.
   */
  function sweepWalkovers() {
    let ended = 0;
    const cutoff = now() - config.abandonMs;

    // A copy: finishing a game removes nothing from this map, but a player who reconnects
    // mid-sweep does, and that is a test the walkover below has to pass rather than race.
    for (const [userId, since] of [...awaySince]) {
      if (since > cutoff) continue;

      for (const row of storage.listPlayingGamesForUser(database, userId)) {
        const game = storage.toPublicGame(row);
        const opponentId = game.host.id === userId
          ? (game.guest === null ? null : game.guest.id)
          : game.host.id;
        // Both players gone is not a walkover, it is an abandoned game: the sweep below
        // removes it, and there is nobody left to tell either way.
        if (opponentId === null || !streams.has(opponentId)) continue;
        if (!storage.finishGame(database, game.id, opponentId, now(), false)) continue;

        logger.info(`game ${game.id} awarded to user ${opponentId}: user ${userId} did not return`);
        notifyOver(game.id, 'walkover');
        ended++;
      }
    }
    return ended;
  }

  /**
   * Drop games nobody has been connected to for `abandonMs`.
   *
   * This is the last resort for a match *both* players walked away from: a row that the
   * lobby considers live blocks whichever of them comes back, and there is nobody left to
   * hand the match to. Runs on its own timer, so it costs one small query when there is
   * nothing to do.
   */
  function sweepAbandoned() {
    const stale = storage.listStaleGames(database, now() - config.abandonMs);
    if (stale.length === 0) return 0;

    const abandoned = stale.filter((row) => !streams.has(Number(row.host_id)) && !streams.has(Number(row.guest_id)));
    if (abandoned.length === 0) return 0;

    const removed = storage.deleteGames(database, abandoned.map((row) => Number(row.id)));
    if (removed > 0) {
      for (const row of abandoned) reports.delete(Number(row.id));
      logger.info(`swept ${removed} abandoned game${removed === 1 ? '' : 's'}`);
      broadcastLobby();
    }
    return removed;
  }

  /**
   * One tick of the cleaner: matches first, then rows.
   *
   * In that order, and not for tidiness: a game finished as a walkover is no longer
   * 'playing', so the second half cannot also delete it as an abandoned game in the same
   * tick — which would throw away the result the players were about to be shown.
   */
  function sweep() {
    return sweepWalkovers() + sweepAbandoned();
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
    // Everyone still marked away is about to lose the stream that would have brought them
    // back, and a walkover decided during a shutdown is a result nobody can be told about.
    awaySince.clear();
    reports.clear();
  }

  return {
    openStream,
    send,
    payload,
    broadcastLobby,
    gameState,
    broadcastGameState,
    notifyMatch,
    notifyShot,
    notifyChat,
    notifyOver,
    recordResult,
    forgetResult,
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
