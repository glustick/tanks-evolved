/**
 * api.js — the JSON surface: five endpoints and the rules that apply to all of them.
 *
 * Every handler is a plain function returning a description of the response, and the
 * dispatcher below is the only place that writes one. That keeps the cookie flags, the
 * rate limiter, the error shape and the logging hook from drifting apart per route, and
 * it means a handler cannot accidentally bypass them.
 */
'use strict';

const { httpError, isHttpError, readJsonBody, sendJson, clientIp } = require('./http');
const { requireEmail, requirePassword } = require('./validate');
const passwords = require('./passwords');
const sessions = require('./sessions');
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
 *   now?: () => number}} deps
 * @returns {{handle: (req, res, url) => Promise<void>, routes: object[]}}
 */
function createApi({ config, database, version, limiters, now = Date.now }) {
  /**
   * Count this attempt against the endpoint's bucket and refuse it if the window is
   * full. Counted before the body is read or validated: an attempt is an attempt, and a
   * limiter that only counted well-formed ones would let an attacker send unlimited
   * malformed traffic (and unlimited scrypt work) for free.
   */
  function enforceRateLimit(bucketName, req) {
    const result = limiters[bucketName].check(clientIp(req));
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

  // -------------------------------------------------------------------- routing

  const routes = [
    { method: 'GET', path: '/api/health', bucket: null, handler: health },
    { method: 'POST', path: '/api/auth/register', bucket: 'register', handler: register },
    { method: 'POST', path: '/api/auth/login', bucket: 'login', handler: login },
    { method: 'POST', path: '/api/auth/logout', bucket: null, handler: logout },
    { method: 'GET', path: '/api/me', bucket: null, handler: me }
  ];

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
    const ctx = { req, res, now };
    let response;
    try {
      const route = routes.find((candidate) => candidate.path === url.pathname);
      if (!route) throw httpError(404, 'not_found', 'no such endpoint');

      if (route.method !== req.method) {
        // 405 with an Allow header rather than 404: the endpoint exists, the verb does
        // not fit it, and saying so is more useful than pretending otherwise. Still
        // JSON — nothing under /api/ ever answers with the client's HTML.
        const allow = routes
          .filter((candidate) => candidate.path === url.pathname)
          .map((candidate) => candidate.method)
          .join(', ');
        throw httpError(405, 'method_not_allowed', `${req.method} is not allowed on this endpoint`, { Allow: allow });
      }

      if (route.bucket) enforceRateLimit(route.bucket, req);
      response = await route.handler(ctx);
    } catch (err) {
      response = errorResponse(err);
    }

    sendJson(res, response.status, response.body, response.headers);  }

  return { handle, routes };
}

module.exports = { createApi, isApiPath, INVALID_CREDENTIALS };
