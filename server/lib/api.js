/**
 * api.js — the JSON surface: the Phase 1 account endpoints, the Phase 2 lobby and the
 * Phase 3 match, plus the rules that apply to all of them.
 *
 * Every handler is a plain function returning a description of the response, and the
 * dispatcher below is the only place that writes one. That keeps the cookie flags, the
 * rate limiter, the error shape and the logging hook from drifting apart per route, and
 * it means a handler cannot accidentally bypass them. The one exception is the event
 * stream, which has no end and therefore cannot be described — it returns
 * RESPONSE_TAKEN and owns its socket from there.
 *
 * The HTTP rules live here and the bookkeeping lives in lobby.js: this file decides what
 * a 409 means, that module decides who is connected and who is waiting.
 *
 * Nothing in this file simulates. A shot is relayed and its hash recorded, never
 * replayed and never judged: the two clients are the only things that know what the
 * world looks like, and the server's whole contribution to "are they in step" is to
 * compare what they say. That is a property worth stating plainly, because it is the
 * reason the endpoints here are so short.
 */
'use strict';

const { httpError, isHttpError, readJsonBody, sendJson, clientIp, RESPONSE_TAKEN } = require('./http');
const { requireEmail, requirePassword, requireShot, requireMessage, requireWinner, requireStateHash } = require('./validate');
const passwords = require('./passwords');
const sessions = require('./sessions');
const { makeSeed } = require('./lobby');
const storage = require('./db');
const logger = require('./logger');

/**
 * The single message for every failed login, whatever went wrong.
 *
 * Wrong password and unknown address are the same string, the same status and (via
 * passwords.verifyUnknown) the same amount of work, so login cannot be used to find out
 * which addresses are registered. It is also deliberately not "invalid email": telling
 * a player which of the two fields was wrong is a courtesy worth less than the account
 * list it hands an attacker.
 */
const INVALID_CREDENTIALS = 'email or password is incorrect';

/** Whether a path belongs to the API rather than the static client. */
function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * @param {{config: object, database: object, version: string, limiters: object,
 *   lobby: object, now?: () => number}} deps
 * @returns {{handle: (req, res, url) => Promise<void>, routes: object[]}}
 */
function createApi({ config, database, version, limiters, lobby, now = Date.now }) {
  /**
   * Count this attempt against the endpoint's bucket and refuse it if the window is
   * full. Counted before the body is read or validated: an attempt is an attempt, and a
   * limiter that only counted well-formed ones would let an attacker send unlimited
   * malformed traffic (and unlimited scrypt work) for free.
   *
   * `subject` overrides what the count is keyed by. The endpoints that anybody can reach
   * leave it out and are keyed by address, which is the only identity that exists before
   * a session does; the endpoints inside a match pass the player's id, because what they
   * bound is one player flooding a room rather than one address making requests — see
   * ratelimit.js.
   */
  function enforceRateLimit(bucketName, req, subject) {
    const key = subject === undefined ? clientIp(req) : subject;
    const result = limiters[bucketName].check(key);
    if (!result.allowed) {
      throw httpError(429, 'rate_limited', 'too many attempts — please wait and try again',
        { 'Retry-After': String(result.retryAfterSeconds) });
    }
  }

  /** Resolve the cookie to a user, or fail the request with 401. */
  function requireUser(req) {
    const token = sessions.readToken(req.headers.cookie);
    if (token === null) throw httpError(401, 'unauthenticated', 'sign in to continue');

    const found = storage.findSessionUser(database, sessions.hashToken(token), now());
    if (found === null) throw httpError(401, 'unauthenticated', 'sign in to continue');
    return found.user;
  }

  /** Start a session for a user and describe the response that carries it. */
  function startSession(user, status) {
    const session = sessions.createSession(config.sessionTtlMs, now());
    storage.insertSession(database, {
      userId: user.id,
      tokenHash: session.tokenHash,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt
    });
    return {
      status,
      body: { user },
      headers: { 'Set-Cookie': sessions.sessionCookie(session.token, config) }
    };
  }

  // ------------------------------------------------------------------ handlers

  /** The container healthcheck target: no auth, no database read, just "I am serving". */
  function health() {
    return { status: 200, body: { ok: true, version } };
  }

  async function register(ctx) {
    const body = await readJsonBody(ctx.req, config.bodyLimitBytes);
    const email = requireEmail(body);
    const password = requirePassword(body);

    const createdAt = now();
    const record = await passwords.hash(password);
    const id = storage.insertUser(database, Object.assign({ email, createdAt }, record));

    // The one place an account's existence is observable, and it has to be: a player
    // registering an address that is taken needs to be told. That is why this endpoint
    // has the tightest rate limit of the two.
    if (id === null) throw httpError(409, 'email_taken', 'that email address already has an account');

    return startSession({ id, email, createdAt }, 201);
  }

  async function login(ctx) {
    const body = await readJsonBody(ctx.req, config.bodyLimitBytes);
    const email = requireEmail(body);
    const password = requirePassword(body);

    const row = storage.findUserByEmail(database, email);
    // The same scrypt work whether or not the address exists. Without this, "no such
    // user" would return in microseconds and "wrong password" in ~100 ms, and the
    // response body would not matter.
    const ok = row ? await passwords.verify(password, row) : await passwords.verifyUnknown(password);
    if (!ok) throw httpError(401, 'invalid_credentials', INVALID_CREDENTIALS);

    return startSession(storage.toPublicUser(row), 200);
  }

  function logout(ctx) {
    const token = sessions.readToken(ctx.req.headers.cookie);
    if (token !== null) storage.deleteSession(database, sessions.hashToken(token));

    // Always 200, and the cookie is cleared either way. Logging out of a session that
    // has already expired is not an error, and answering differently would make this
    // endpoint a session-validity oracle — which is the thing the 401 on /api/me is for.
    return {
      status: 200,
      body: { ok: true },
      headers: { 'Set-Cookie': sessions.expiredCookie(config) }
    };
  }

  function me(ctx) {
    return { status: 200, body: { user: requireUser(ctx.req) } };
  }

  // --------------------------------------------------------------------- lobby

  /**
   * The caller's own live game, or null.
   *
   * A *playing* game does not stand in the way of anything: a player who has finished
   * one match must be able to start another, and Phase 2 has no way to end a game yet.
   * What it does do is appear in every lobby payload as `you.game`, so nobody loses
   * track of the match they are already in.
   */
  function liveGameFor(userId) {
    const row = storage.findLiveGameForUser(database, userId);
    return row === null ? null : storage.toPublicGame(row);
  }

  /**
   * Refuse a game this player is hosting that nobody has joined.
   *
   * An open game is a claim on a seat: hosting a second one, or queueing for a different
   * opponent while one sits in the lobby, would leave the first listed with a host who
   * has stopped watching it.
   */
  function requireNoOpenGame(userId) {
    const open = storage.findOpenGameHostedBy(database, userId);
    if (open !== null) {
      throw httpError(409, 'already_hosting',
        `you are already hosting game ${Number(open.id)} — cancel it or wait for an opponent`);
    }
  }

  /** The game id from a parameterised route. The pattern already guaranteed digits. */
  function gameIdOf(ctx) {
    return Number(ctx.params.id);
  }

  function lobbyState(ctx) {
    const user = requireUser(ctx.req);
    return { status: 200, body: lobby.payload(user.id) };
  }

  /**
   * The event stream. Everything after this line is written by lobby.js, which is why
   * this is the one handler that does not return a response.
   */
  function stream(ctx) {
    const user = requireUser(ctx.req);
    lobby.openStream(ctx.res, user);
    return RESPONSE_TAKEN;
  }

  /**
   * Host a game.
   *
   * Everything between the check and the insert is synchronous, and so is storage, so two
   * requests from the same player cannot both find "no open game there" — which is what
   * "at most one open game" rests on. That is a property of one process and a
   * single-threaded database, not of the check itself; a second replica would need the
   * partial unique index this deliberately does not have.
   */
  function hostGame(ctx) {
    const user = requireUser(ctx.req);
    requireNoOpenGame(user.id);

    const createdAt = now();
    const id = storage.insertGame(database, {
      seed: null,
      hostId: user.id,
      guestId: null,
      status: storage.GAME_OPEN,
      createdAt,
      startedAt: null
    });

    const game = storage.toPublicGame(storage.findGameById(database, id));
    logger.info(`game ${game.id} hosted by user ${user.id}`);
    lobby.broadcastLobby();
    return { status: 201, body: { game } };
  }

  /**
   * Join an open game: fill the empty seat, issue the seed, tell both players.
   *
   * The seed is made here and not sent by the client, so neither player can pick a map
   * they have practised. Ownership is checked before status, so a host who tries to join
   * their own game is told that rather than "already started".
   */
  function joinGame(ctx) {
    const user = requireUser(ctx.req);
    const id = gameIdOf(ctx);

    const row = storage.findGameById(database, id);
    if (row === null) throw httpError(404, 'no_such_game', 'that game is no longer in the lobby');
    if (Number(row.host_id) === user.id) throw httpError(409, 'own_game', 'you are hosting this game');
    if (row.status !== storage.GAME_OPEN) throw httpError(409, 'game_not_open', 'that game has already started');
    requireNoOpenGame(user.id);

    const seed = makeSeed();
    if (!storage.claimGame(database, id, user.id, seed, now())) {
      // Lost the race for the seat: the WHERE in claimGame is what decided it.
      throw httpError(409, 'game_not_open', 'that game has already started');
    }

    const game = storage.toPublicGame(storage.findGameById(database, id));
    logger.info(`game ${game.id} started, hosted by user ${game.host.id}, joined by user ${user.id}`);
    lobby.notifyMatch(game);
    lobby.broadcastLobby();
    return { status: 200, body: { game } };
  }

  /** Cancel an open game. Only its host, and only while nobody has joined. */
  function cancelGame(ctx) {
    const user = requireUser(ctx.req);
    const id = gameIdOf(ctx);

    const row = storage.findGameById(database, id);
    if (row === null) throw httpError(404, 'no_such_game', 'no such game');
    if (Number(row.host_id) !== user.id) throw httpError(403, 'not_your_game', 'only the host can cancel a game');
    if (row.status !== storage.GAME_OPEN) throw httpError(409, 'game_not_open', 'that game has already started');

    storage.deleteGame(database, id);
    logger.info(`game ${id} cancelled by user ${user.id}`);
    lobby.broadcastLobby();
    return { status: 200, body: { ok: true, id } };
  }

  /**
   * Details for a game, for one of its two players.
   *
   * 403 rather than 404 for everybody else: the game exists and the caller cannot have
   * it. Nothing is hidden by saying so — the same game, minus the seat, is in every
   * lobby list — and a 403 that means "not yours" is far easier to debug than a 404 that
   * means two different things.
   *
   * Finished games are readable too, and that is deliberate: the payload is the whole
   * match — the replay log and the chat as well as the row — so a client that reloaded
   * after the last shot can still rebuild the board it is about to be shown the result of.
   */
  function gameDetails(ctx) {
    const user = requireUser(ctx.req);
    requireParticipant(user, gameIdOf(ctx), null);
    return { status: 200, body: lobby.gameState(gameIdOf(ctx)) };
  }

  // --------------------------------------------------------------------- match

  /**
   * The game behind an id, provided the caller is in it and it is in the state they
   * think it is. Every match endpoint starts here.
   *
   * The id is looked up once and both facts are checked against the row that came back,
   * so a game that was cancelled, swept or finished between the two can never be acted
   * on. `expectedStatus` is the state the caller needs rather than the state they will
   * get: a shot needs a game that is being played, and reading one needs anything.
   */
  function requireParticipant(user, id, expectedStatus) {
    const row = storage.findGameById(database, id);
    if (row === null) throw httpError(404, 'no_such_game', 'no such game');

    const participant = Number(row.host_id) === user.id
      || (row.guest_id !== null && Number(row.guest_id) === user.id);
    if (!participant) throw httpError(403, 'not_your_game', 'that game belongs to other players');

    if (expectedStatus !== null && row.status !== expectedStatus) {
      // Every state that is not 'playing' is worth telling apart by name — finished, in
      // particular, is a match a client should stop sending shots into rather than a
      // match that cannot be found.
      throw httpError(409, 'game_not_playing', row.status === storage.GAME_FINISHED
        ? 'that match has finished'
        : 'that game has not started yet');
    }
    return row;
  }

  /**
   * Take a shot.
   *
   * Three things are checked, and none of them is about the shot's quality because the
   * server cannot judge that: it is not the client that decides whose turn it is (the
   * shot count does), it is not the client that decides whether this turn has been
   * played (the UNIQUE index does), and the aim is bounds-checked so that what is stored
   * is what both clients will fire rather than what each of them clamps to.
   *
   * The response is the whole match state, so a client that lost its stream between
   * firing and being told what happened is answered rather than left guessing.
   */
  async function submitShot(ctx) {
    const user = requireUser(ctx.req);
    const id = gameIdOf(ctx);
    const row = requireParticipant(user, id, storage.GAME_PLAYING);
    enforceRateLimit('shots', ctx.req, `u${user.id}`);

    const body = await readJsonBody(ctx.req, config.bodyLimitBytes);
    const { angle, power, stateHash } = requireShot(body);

    const game = storage.toPublicGame(row);
    const turn = storage.listShots(database, id).length + 1;
    if (storage.activeUserIdFor(game, turn) !== user.id) {
      throw httpError(409, 'not_your_turn', `it is turn ${turn} and it is not yours`);
    }

    const createdAt = now();
    const inserted = storage.insertShot(database, {
      gameId: id, turn, userId: user.id, angle, power, stateHash, createdAt
    });
    // The index, not the check above: two requests for one turn can only both reach here
    // from the same player, and this is where the second one loses.
    if (inserted === null) throw httpError(409, 'turn_played', `turn ${turn} has already been played`);

    const shot = storage.toPublicShot({
      turn, user_id: user.id, angle, power, state_hash: stateHash, created_at: createdAt
    });
    logger.info(`game ${id} turn ${turn}: shot by user ${user.id} at ${angle}° / ${power}%`);
    lobby.notifyShot(id, shot);

    return { status: 201, body: lobby.gameState(id) };
  }

  /** Say something to the opponent. Stored, then broadcast, so a rejoin sees the history. */
  async function postChat(ctx) {
    const user = requireUser(ctx.req);
    const id = gameIdOf(ctx);
    requireParticipant(user, id, storage.GAME_PLAYING);
    enforceRateLimit('chat', ctx.req, `u${user.id}`);

    const body = await readJsonBody(ctx.req, config.bodyLimitBytes);
    const text = requireMessage(body);

    const createdAt = now();
    storage.insertMessage(database, { gameId: id, userId: user.id, body: text, createdAt });
    const message = storage.toPublicMessage({ user_id: user.id, body: text, created_at: createdAt });
    lobby.notifyChat(id, message);

    // The message, not the match: the sender already has everything else, and the chat
    // event carrying the same object is what the receiving client renders from. One
    // shape, one render path, whichever of the two a client happens to see first.
    return { status: 201, body: { message } };
  }

  /**
   * Report who won, and finish the match when both players have said the same thing.
   *
   * This is the only place the server has an opinion about the outcome, and the opinion
   * is "these two accounts agree". It cannot check a result and does not try: it did not
   * simulate the match, so the two clients' accounts of it are all there is — which is
   * exactly why one of them alone is not enough. A disagreement, in the winner or in the
   * board hash, is a desync: the match ends with nobody's name on it, and both clients
   * are told what happened rather than one of them being handed a victory the other
   * denies.
   *
   * A report is a claim about a board that is still on screen, so it is answered rather
   * than remembered: the client that reports first is told it is waiting, and the one
   * that reports second gets the verdict.
   */
  async function reportResult(ctx) {
    const user = requireUser(ctx.req);
    const id = gameIdOf(ctx);
    const row = requireParticipant(user, id, storage.GAME_PLAYING);

    const body = await readJsonBody(ctx.req, config.bodyLimitBytes);
    const winnerId = requireWinner(body, storage.toPublicGame(row));
    const stateHash = requireStateHash(body);

    const verdict = lobby.recordResult(id, user.id, { winnerId, stateHash });
    if (verdict.status === 'conflict') {
      // The same player, a different answer. Accepting it would make "both agree" a
      // statement about the last thing either of them said rather than about the match.
      throw httpError(409, 'already_reported', 'you have already reported a different result');
    }

    if (verdict.status !== 'waiting' && verdict.status !== 'repeat') {
      const desync = verdict.status === 'desync';
      if (!storage.finishGame(database, id, desync ? null : winnerId, now(), desync)) {
        // A late report that lost a race with the sweep, or a second report from the
        // other player after the match was already finished by the walkover.
        lobby.forgetResult(id);
        throw httpError(409, 'game_not_playing', 'that match has already finished');
      }
      logger.info(desync
        ? `game ${id} ended in a desync: the two clients reported different results`
        : `game ${id} won by user ${winnerId}${winnerId === null ? ' (draw)' : ''}`);
      // notifyOver forgets the two reports: every ending goes through it.
      lobby.notifyOver(id, desync ? 'desync' : 'result');
    }

    const state = lobby.gameState(id);
    return {
      status: 200,
      body: {
        agreed: verdict.status === 'agreed',
        waiting: verdict.status === 'waiting' || verdict.status === 'repeat',
        desync: state.game.desync,
        game: state.game
      }
    };
  }

  /** The queue answer, in one shape whether the caller waited, matched or left. */
  function queueState(userId, game) {
    return {
      waiting: lobby.isWaiting(userId),
      queue: { count: lobby.waiterCount() },
      game: game || liveGameFor(userId)
    };
  }

  /**
   * Enter the quick-match queue, pairing immediately when somebody is already waiting.
   *
   * Idempotent for a caller who is already in it: a second tab, or a client retrying,
   * is told it is waiting rather than given an error for doing what it just did.
   */
  function enterQueue(ctx) {
    const user = requireUser(ctx.req);
    requireNoOpenGame(user.id);
    if (lobby.isWaiting(user.id)) return { status: 200, body: queueState(user.id, null) };

    const opponentId = lobby.takeWaiter(user.id);
    if (opponentId === null) {
      lobby.addWaiter(user.id);
      lobby.send(user.id, 'queue', queueState(user.id, null));
      lobby.broadcastLobby();
      return { status: 200, body: queueState(user.id, null) };
    }

    // Whoever was already waiting hosts, so the pairing is deterministic and the seed is
    // made here either way — neither player ever chooses it.
    const startedAt = now();
    const id = storage.insertGame(database, {
      seed: makeSeed(),
      hostId: opponentId,
      guestId: user.id,
      status: storage.GAME_PLAYING,
      createdAt: startedAt,
      startedAt
    });

    const game = storage.toPublicGame(storage.findGameById(database, id));
    logger.info(`quick match: game ${game.id} between users ${game.host.id} and ${user.id}`);
    lobby.notifyMatch(game);
    lobby.broadcastLobby();
    return { status: 200, body: queueState(user.id, game) };
  }

  /** Stop waiting. Idempotent: leaving a queue you are not in is already the goal. */
  function leaveQueue(ctx) {
    const user = requireUser(ctx.req);
    if (lobby.removeWaiter(user.id)) {
      lobby.send(user.id, 'queue', queueState(user.id, null));
      lobby.broadcastLobby();
    }
    return { status: 200, body: queueState(user.id, null) };
  }

  // -------------------------------------------------------------------- routing

  const routes = [
    { method: 'GET', path: '/api/health', bucket: null, handler: health },
    { method: 'POST', path: '/api/auth/register', bucket: 'register', handler: register },
    { method: 'POST', path: '/api/auth/login', bucket: 'login', handler: login },
    { method: 'POST', path: '/api/auth/logout', bucket: null, handler: logout },
    { method: 'GET', path: '/api/me', bucket: null, handler: me },
    { method: 'GET', path: '/api/lobby', bucket: null, handler: lobbyState },
    { method: 'GET', path: '/api/stream', bucket: null, handler: stream },
    { method: 'POST', path: '/api/games', bucket: 'games', handler: hostGame },
    { method: 'POST', path: '/api/games/:id/join', pattern: /^\/api\/games\/(\d+)\/join$/, bucket: null, handler: joinGame },
    { method: 'POST', path: '/api/games/:id/shot', pattern: /^\/api\/games\/(\d+)\/shot$/, bucket: null, handler: submitShot },
    { method: 'POST', path: '/api/games/:id/chat', pattern: /^\/api\/games\/(\d+)\/chat$/, bucket: null, handler: postChat },
    { method: 'POST', path: '/api/games/:id/result', pattern: /^\/api\/games\/(\d+)\/result$/, bucket: null, handler: reportResult },
    { method: 'POST', path: '/api/queue', bucket: 'queue', handler: enterQueue },
    { method: 'DELETE', path: '/api/queue', bucket: null, handler: leaveQueue },
    { method: 'GET', path: '/api/games/:id', pattern: /^\/api\/games\/(\d+)$/, bucket: null, handler: gameDetails },
    { method: 'DELETE', path: '/api/games/:id', pattern: /^\/api\/games\/(\d+)$/, bucket: null, handler: cancelGame }
  ];

  /**
   * Whether a route serves a path, and what its parameters are: an object of them, or
   * null when the path is somebody else's. Routes with a `path` and no `pattern` are
   * exact matches, which is most of them; `/api/games/:id` owns a family of paths, and
   * the digits-only pattern is what keeps `/api/games/abc` a 404 rather than a lookup
   * with a string where an id belongs.
   */
  function matchRoute(route, pathname) {
    if (route.path === pathname && !route.pattern) return {};
    if (!route.pattern) return null;
    const match = route.pattern.exec(pathname);
    return match === null ? null : { id: match[1] };
  }

  /** A handler failure turned into a response. Never leaks a stack, a query or a path. */
  function errorResponse(err) {
    if (isHttpError(err)) {
      return { status: err.status, body: { error: err.code, message: err.message }, headers: err.headers };
    }
    // Anything else is a bug: logged in full here (the only place a stack is allowed to
    // appear), and reported to the client as nothing at all.
    logger.error('unhandled error in an API handler', err);
    return { status: 500, body: { error: 'internal_error', message: 'something went wrong' } };
  }

  /**
   * Dispatch one /api/ request. Always resolves: every failure becomes a response, so
   * the caller never has to guard against this rejecting.
   */
  async function handle(req, res, url) {
    const matching = routes.filter((route) => matchRoute(route, url.pathname) !== null);
    let response;
    try {
      if (matching.length === 0) throw httpError(404, 'not_found', 'no such endpoint');

      const route = matching.find((candidate) => candidate.method === req.method);
      if (!route) {
        // 405 with an Allow header rather than 404: the endpoint exists, the verb does
        // not fit it, and saying so is more useful than pretending otherwise. Still
        // JSON — nothing under /api/ ever answers with the client's HTML.
        const allow = matching.map((candidate) => candidate.method).join(', ');
        throw httpError(405, 'method_not_allowed', `${req.method} is not allowed on this endpoint`, { Allow: allow });
      }

      if (route.bucket) enforceRateLimit(route.bucket, req);
      response = await route.handler({ req, res, now, params: matchRoute(route, url.pathname) });
    } catch (err) {
      response = errorResponse(err);
    }

    // The one handler that owns its own socket from here on is the event stream, which
    // has no end and so cannot be described by a status and a body.
    if (response === RESPONSE_TAKEN) return;

    sendJson(res, response.status, response.body, response.headers);
  }

  return { handle, routes };
}

module.exports = { createApi, isApiPath, INVALID_CREDENTIALS };
