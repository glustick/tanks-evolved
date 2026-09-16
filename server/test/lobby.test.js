#!/usr/bin/env node
/**
 * server/test/lobby.test.js — Phase 2 acceptance: the lobby, matchmaking and the event
 * stream, over real HTTP.
 *
 * Like the Phase 1 suite next to it, the server under test is the real one — spawned as a
 * child process on an ephemeral port against a database in a temporary directory — and
 * every request goes over the wire with fetch. Cookies are carried by hand, because
 * "which cookie gets which answer" is most of what a two-player flow is.
 *
 * The event stream is read with fetch and a reader rather than with EventSource: what
 * this file has to prove is the bytes on the wire — the event names, the JSON bodies, the
 * keepalive comments and the count the server logs when a stream comes and goes — and
 * EventSource hides all four behind its own API.
 *
 * Where a check corresponds to an item in the Phase 2 brief, the name says so:
 *
 *   brief 1  -> 2     brief 5  -> 6      brief 9  -> 11
 *   brief 2  -> 3     brief 6  -> 7      brief 10 -> 12
 *   brief 3  -> 4     brief 7  -> 9      brief 11 -> 13
 *   brief 4  -> 5     brief 8  -> 10     brief 12 -> 15
 *
 * Three checks are additions: 17 bounds how many sockets one account may hold, 18 proves
 * an abandoned game is swept, and 19/20 are the shutdown and log checks the auth suite
 * next door also ends with.
 *
 * Usage:  node server/test/lobby.test.js
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'index.js');
const REPO_ROOT = path.join(__dirname, '..', '..');

const COOKIE_NAME = 'te_session';
const PASSWORD = 'correct-horse-battery-4821';

// Distinct local parts, so a display name identifies a player unambiguously in a failure
// message and an email address in a response is never ambiguous either.
const PLAYERS = {
  a: 'anna@example.com',
  b: 'bruno@example.com',
  c: 'chen@example.com',
  d: 'dana@example.com',
  e: 'eli@example.com',
  g: 'gita@example.com',
  h: 'hana@example.com',
  i: 'ivan@example.com',
  s: 'sasha@example.com'
};

// Every limit is set here rather than assumed, for the reason the auth suite gives: every
// request in this file comes from one address, which is exactly what the per-IP limiter is
// for. The two bucket sizes are the ones the rate-limit check then measures against, so
// they are deliberately small — a suite that has to send twenty games to find the edge is
// twenty games slower for the same evidence.
const GAMES_MAX = 12;
const QUEUE_MAX = 10;
// The per-player stream cap, set low enough that measuring it does not mean opening eight
// sockets per run. It has to match TANKS_MAX_STREAMS_PER_USER below.
const STREAMS_MAX = 3;
const REGISTER_MAX = 40;
const LOGIN_MAX = 40;

// The window a dropped connection has to come back. Short here because the cleanup it
// guards is one of the things under test — see check 14.
const STREAM_GRACE_MS = 300;
// One second is the floor the keepalive accepts: the shortest wait that still proves a
// keepalive arrives, without making the suite wait for a production-sized one.
const STREAM_KEEPALIVE_MS = 1000;
// Five minutes, i.e. longer than this file runs: an abandoned-game sweep must never
// remove a game a later check still refers to. Check 17 measures the sweep on its own
// server, where both window and interval can be a fraction of a second.
const ABANDON_MS = 5 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

// ------------------------------------------------------------------ test runner
const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail == null ? '' : String(detail) });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(ok, message) {
  if (!ok) throw new Error(message);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ----------------------------------------------------------------- processes
/** Start the server as a child process, capturing its output for the log-based checks. */
function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  return { child, logs };
}

/** The base URL the server reports once it is listening, or a useful failure. */
function waitForListen(server) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`no listening address after 20s:\n${server.logs.join('')}`));
    }, 20000);

    const poll = () => {
      const match = /listening on (http:\/\/\S+)/.exec(server.logs.join(''));
      if (match) {
        clearTimeout(deadline);
        resolve(match[1]);
      } else if (server.child.exitCode !== null || server.child.signalCode !== null) {
        clearTimeout(deadline);
        reject(new Error(`the server exited (code ${server.child.exitCode}) instead of listening:\n${server.logs.join('')}`));
      } else {
        setTimeout(poll, 25);
      }
    };
    poll();
  });
}

/** SIGTERM the child and report how it went. */
function stopServer(server) {
  return new Promise((resolve) => {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      resolve({ code: server.child.exitCode, signal: server.child.signalCode, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      server.child.kill('SIGKILL');
      resolve({ code: null, signal: 'SIGKILL', timedOut: true });
    }, 10000);
    server.child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
    server.child.kill('SIGTERM');
  });
}

// ----------------------------------------------------------------------- HTTP
/** The suite's own bookkeeping: who has signed in, what was sent, what came back. */
const state = {
  base: null,
  players: {},
  responses: [],
  streams: [],
  streamsClosed: [],
  attempts: { games: 0, queue: 0 }
};

/** The Cookie header value for a player this suite has registered. */
function cookieFor(key) {
  const player = state.players[key];
  if (!player) throw new Error(`no session for player ${key} — was the registration skipped?`);
  return `${COOKIE_NAME}=${player.token}`;
}

/**
 * One request, as one player or as nobody.
 *
 * Every response is kept, with the address of whoever asked for it, because that is what
 * makes check 15 possible: "no response contains another player's email" is a statement
 * about the whole conversation, not about one endpoint.
 */
async function call(method, target, options = {}) {
  if (method === 'POST' && target === '/api/games') state.attempts.games++;
  if (method === 'POST' && target === '/api/queue') state.attempts.queue++;

  const headers = Object.assign({}, options.headers);
  if (options.as) headers.Cookie = cookieFor(options.as);

  let body;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }

  const res = await fetch(state.base + target, { method, headers, body });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not every response is JSON (the static client is not).
  }
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);

  const record = {
    method,
    path: target,
    as: options.as ? state.players[options.as].email : null,
    status: res.status,
    text
  };
  state.responses.push(record);

  return { status: res.status, headers: res.headers, text, json, setCookies, record };
}

function tokenOf(response) {
  const cookie = response.setCookies.find((entry) => entry.startsWith(`${COOKIE_NAME}=`)) || null;
  return cookie === null ? null : cookie.slice(COOKIE_NAME.length + 1).split(';')[0];
}

// ------------------------------------------------------------- event streams
/**
 * Read one Server-Sent Events response as it arrives.
 *
 * Aborting is how a stream ends here, which is deliberate: it is the same thing a closed
 * tab does, and the server's reaction to it is what checks 13 and 14 are about.
 */
function openStream(key) {
  const controller = new AbortController();
  const stream = {
    key,
    events: [],
    comments: [],
    status: null,
    contentType: null,
    error: null,
    text: ''
  };

  function ingest(block) {
    let name = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) stream.comments.push(line.slice(1).trim());
      else if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data.length === 0) return; // a keepalive with nothing else in the block
    try {
      stream.events.push({ name, data: JSON.parse(data) });
    } catch (err) {
      throw new Error(`the stream sent unparseable data for ${name}: ${data}`);
    }
  }

  // `opened` settles on the response headers, not on the end of the body: a stream has no
  // end until somebody aborts it, and awaiting the whole thing here would hang forever.
  // The reading continues in the background and fills in `events` as it arrives.
  stream.opened = fetch(`${state.base}/api/stream`, {
    headers: { Cookie: cookieFor(key) },
    signal: controller.signal
  }).then((res) => {
    stream.status = res.status;
    stream.contentType = res.headers.get('content-type');
    if (!res.ok) return res.text().then((text) => { stream.error = text; });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) return undefined;
      const chunk = decoder.decode(value, { stream: true });
      stream.text += chunk;
      buffer += chunk;
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop(); // the last one is a partial event until the next chunk
      for (const block of blocks) ingest(block);
      return pump();
    }).catch(() => undefined); // an abort is a normal way for this to end
    pump();
    return undefined;
  }).catch((err) => {
    stream.error = (err && err.message) || String(err);
  });

  /** Wait for an event matching a predicate, or fail with what did arrive instead. */
  stream.waitFor = async (name, predicate, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = stream.events.find((event) => event.name === name && (!predicate || predicate(event.data)));
      if (found) return found.data;
      await sleep(20);
    }
    const seen = stream.events.map((event) => event.name).join(', ') || 'nothing';
    throw new Error(`no ${name} event within ${timeoutMs}ms (saw: ${seen})`);
  };

  /** Wait for a keepalive comment: the thing that stops an idle proxy closing the stream. */
  stream.waitForComment = async (timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (stream.comments.length > 0) return stream.comments[0];
      await sleep(20);
    }
    throw new Error(`no keepalive comment within ${timeoutMs}ms`);
  };

  stream.close = () => controller.abort();

  state.streams.push(stream);
  return stream;
}

/**
 * The server's own count of open streams, read out of its log.
 *
 * A guess would defeat the purpose of the check — the question is whether the server
 * removed the subscription, and only the server can answer it.
 */
function lastStreamCount(server) {
  const matches = [...server.logs.join('').matchAll(/stream (?:open|close) user=\d+ streams=(\d+)/g)];
  return matches.length === 0 ? null : Number(matches[matches.length - 1][1]);
}

async function waitForStreamCount(server, expected, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lastStreamCount(server) === expected) return expected;
    await sleep(20);
  }
  throw new Error(`the server's open-stream count never reached ${expected} (last logged: ${lastStreamCount(server)})\n${server.logs.join('')}`);
}

/** Register one of PLAYERS and remember its session. */
async function register(key) {
  const res = await call('POST', '/api/auth/register', { json: { email: PLAYERS[key], password: PASSWORD } });
  assert(res.status === 201, `registering ${PLAYERS[key]} returned ${res.status} ${res.text}`);
  state.players[key] = { email: PLAYERS[key], id: res.json.user.id, token: tokenOf(res) };
  // The response carries the new account's own address, which is not a leak but is also
  // not attributable until the session cookie has been read — so the recorded caller is
  // filled in here rather than left as "nobody" (see check 15).
  res.record.as = PLAYERS[key];
  return state.players[key];
}

// ---------------------------------------------------------------------- suite
async function runChecks(server, dataDir) {
  await check('1. nine players register, each with a display name that is the local part of their email', async () => {
    for (const key of Object.keys(PLAYERS)) await register(key);

    // The Phase 1 body shape is unchanged: an account response is about *you*, and
    // displayName only exists where other players have to render a name.
    const me = await call('GET', '/api/me', { as: 'a' });
    assert(String(me.json.user.id) === String(state.players.a.id), `GET /api/me returned the wrong account: ${me.text}`);
    assert(me.json.user && !('displayName' in me.json.user),
      `the Phase 1 user shape grew a field: ${me.text}`);

    const lobby = await call('GET', '/api/lobby', { as: 'a' });
    assert(lobby.json.you.player.displayName === 'anna',
      `displayName was not defaulted from the email: ${lobby.text}`);
    return `${Object.keys(PLAYERS).length} accounts, e.g. anna@example.com -> displayName "anna"`;
  });

  await check('2. GET /api/lobby and /api/stream without a session are 401 [brief 1]', async () => {
    for (const target of ['/api/lobby', '/api/stream']) {
      const res = await call('GET', target);
      assert(res.status === 401, `${target} without a cookie returned ${res.status} ${res.text}`);
      assert(res.json && res.json.error === 'unauthenticated', `${target} returned ${res.text}`);
    }
    // Nor with a made-up token: the stream is a long-lived authenticated connection, so
    // "authenticated once and never again" is worth ruling out explicitly.
    const forged = await fetch(`${state.base}/api/stream`, { headers: { Cookie: `${COOKIE_NAME}=not-a-real-token` } });
    assert(forged.status === 401, `a forged token was accepted on /api/stream (${forged.status})`);
    await forged.body.cancel();
    return '401 unauthenticated with no cookie and with a forged one, for both endpoints';
  });

  await check('3. A hosts a game and B sees it in the lobby [brief 2]', async () => {
    const res = await call('POST', '/api/games', { as: 'a' });
    assert(res.status === 201, `hosting returned ${res.status} ${res.text}`);
    const game = res.json.game;
    assert(Number.isInteger(game.id), `no game id: ${res.text}`);
    assert(game.status === 'open', `a hosted game is not open: ${res.text}`);
    assert(game.guest === null && game.seed === null, `an open game already has a guest or a seed: ${res.text}`);
    assert(game.host.id === state.players.a.id && game.host.displayName === 'anna',
      `the host is wrong: ${res.text}`);

    const lobby = await call('GET', '/api/lobby', { as: 'b' });
    const listed = lobby.json.games.find((candidate) => candidate.id === game.id);
    assert(listed, `B's lobby does not list game ${game.id}: ${lobby.text}`);
    assert(listed.host.displayName === 'anna', `the listed host is wrong: ${lobby.text}`);
    assert(listed.createdAt === game.createdAt, `createdAt does not match: ${lobby.text}`);

    // The host sees it as their own, and B does not.
    assert(lobby.json.you.game === null, `B's lobby claims a game of their own: ${lobby.text}`);
    const own = await call('GET', '/api/lobby', { as: 'a' });
    assert(own.json.you.game && own.json.you.game.id === game.id, `A's lobby lost their own game: ${own.text}`);

    state.hostedGame = game;
    return `game ${game.id} by "anna", listed for B with createdAt ${game.createdAt}, "you.game" set for A only`;
  });

  await check('4. a second POST /api/games from the same player is 409 [brief 3]', async () => {
    const res = await call('POST', '/api/games', { as: 'a' });
    assert(res.status === 409, `a second host returned ${res.status} ${res.text}`);
    assert(res.json.error === 'already_hosting', `unexpected error code: ${res.text}`);

    const lobby = await call('GET', '/api/lobby', { as: 'a' });
    const mine = lobby.json.games.filter((game) => game.host.id === state.players.a.id);
    assert(mine.length === 1, `A has ${mine.length} open games, expected 1: ${lobby.text}`);
    return `409 ${res.json.error} ("${res.json.message}"), still exactly one open game`;
  });

  await check('5. B joins A\'s game: both see "playing", with a server-issued seed [brief 4]', async () => {
    const res = await call('POST', `/api/games/${state.hostedGame.id}/join`, { as: 'b' });
    assert(res.status === 200, `joining returned ${res.status} ${res.text}`);

    const game = res.json.game;
    assert(game.status === 'playing', `the game is not playing: ${res.text}`);
    assert(game.guest && game.guest.displayName === 'bruno', `the guest is wrong: ${res.text}`);
    assert(typeof game.seed === 'string' && /^[A-Z]+-\d{4}$/.test(game.seed),
      `the seed is not a plausible server-issued one: ${res.text}`);
    assert(Number.isInteger(game.startedAt) && game.startedAt >= game.createdAt,
      `startedAt is missing or before createdAt: ${res.text}`);

    // Both participants, and nobody else, can read it back — and both see the same seed.
    const fromHost = await call('GET', `/api/games/${game.id}`, { as: 'a' });
    assert(fromHost.status === 200, `the host cannot read their own game: ${fromHost.text}`);
    assert(fromHost.json.game.seed === game.seed && fromHost.json.game.status === 'playing',
      `the host sees something different: ${fromHost.text}`);

    const lobby = await call('GET', '/api/lobby', { as: 'c' });
    assert(!lobby.json.games.some((entry) => entry.id === game.id),
      `a started game is still in the lobby: ${lobby.text}`);

    state.playedGame = game;
    return `game ${game.id} playing, seed ${game.seed}, same for host and guest, gone from the open list`;
  });

  await check('6. a third player cannot join a game that is already playing [brief 5]', async () => {
    const res = await call('POST', `/api/games/${state.playedGame.id}/join`, { as: 'c' });
    assert(res.status === 409, `joining a started game returned ${res.status} ${res.text}`);
    assert(res.json.error === 'game_not_open', `unexpected error code: ${res.text}`);

    const lobby = await call('GET', '/api/lobby', { as: 'c' });
    assert(lobby.json.you.game === null, `C was put into a game they never joined: ${lobby.text}`);

    // An id that is not there, and one that could not be an id at all.
    const missing = await call('POST', '/api/games/99999/join', { as: 'c' });
    assert(missing.status === 404 && missing.json.error === 'no_such_game',
      `a missing game returned ${missing.status} ${missing.text}`);
    const nonsense = await call('POST', '/api/games/abc/join', { as: 'c' });
    assert(nonsense.status === 404, `a non-numeric id returned ${nonsense.status} ${nonsense.text}`);
    return `409 ${res.json.error} for the started game, 404 for a missing id and for a non-numeric one`;
  });

  await check('7. the host cannot join their own game [brief 6]', async () => {
    // A fresh open game, so the check is about the seat rather than about the status.
    const hosted = await call('POST', '/api/games', { as: 'd' });
    assert(hosted.status === 201, `D could not host: ${hosted.status} ${hosted.text}`);

    const own = await call('POST', `/api/games/${hosted.json.game.id}/join`, { as: 'd' });
    assert(own.status === 409, `the host joined their own open game (${own.status} ${own.text})`);
    assert(own.json.error === 'own_game', `unexpected error code: ${own.text}`);

    // And on a game that has started, where "already started" would be the easy answer:
    // ownership is what is being refused, so the specific code has to win.
    const started = await call('POST', `/api/games/${state.playedGame.id}/join`, { as: 'a' });
    assert(started.status === 409 && started.json.error === 'own_game',
      `the host of a playing game was not told they host it: ${started.status} ${started.text}`);

    state.dGame = hosted.json.game;
    return `409 ${own.json.error} on an open game and on a playing one ("${own.json.message}")`;
  });

  await check('8. only the host cancels an open game, and cancelling takes it out of the lobby', async () => {
    const stranger = await call('DELETE', `/api/games/${state.dGame.id}`, { as: 'c' });
    assert(stranger.status === 403, `a stranger cancelled a game (${stranger.status} ${stranger.text})`);
    assert(stranger.json.error === 'not_your_game', `unexpected error code: ${stranger.text}`);

    const before = await call('GET', '/api/lobby', { as: 'c' });
    assert(before.json.games.some((game) => game.id === state.dGame.id),
      `the game was never in the lobby to begin with: ${before.text}`);

    const cancelled = await call('DELETE', `/api/games/${state.dGame.id}`, { as: 'd' });
    assert(cancelled.status === 200, `the host could not cancel their game (${cancelled.status} ${cancelled.text})`);

    const after = await call('GET', '/api/lobby', { as: 'c' });
    assert(!after.json.games.some((game) => game.id === state.dGame.id),
      `a cancelled game is still listed: ${after.text}`);
    const gone = await call('GET', `/api/games/${state.dGame.id}`, { as: 'd' });
    assert(gone.status === 404, `a cancelled game can still be read (${gone.status} ${gone.text})`);

    // Cancelling twice: the second one has nothing to cancel, which is not an error the
    // client needs to handle differently.
    const again = await call('DELETE', `/api/games/${state.dGame.id}`, { as: 'd' });
    assert(again.status === 404, `cancelling twice returned ${again.status} ${again.text}`);
    return `403 for a stranger, 200 + gone from the lobby for the host, 404 on the second attempt`;
  });

  await check('9. quick match: A waits, B queues and the two are paired into one game [brief 7]', async () => {
    const first = await call('POST', '/api/queue', { as: 'a' });
    assert(first.status === 200, `queueing returned ${first.status} ${first.text}`);
    assert(first.json.waiting === true, `the first player is not waiting: ${first.text}`);
    // `game` is "the game you are in", which for A is still the match from check 5: a
    // playing game does not stop anybody queueing for the next one. What must not have
    // happened is a *new* game, and the queue depth says whether one was made.
    assert(!first.json.game || first.json.game.id === state.playedGame.id,
      `queueing made a game for the first player: ${first.text}`);
    assert(first.json.queue.count === 1, `the queue depth is wrong: ${first.text}`);

    const seenByOther = await call('GET', '/api/lobby', { as: 'c' });
    assert(seenByOther.json.queue.count === 1, `the queue depth is not shared: ${seenByOther.text}`);

    const second = await call('POST', '/api/queue', { as: 'b' });
    assert(second.status === 200, `the second queue returned ${second.status} ${second.text}`);
    assert(second.json.waiting === false, `the second player is still waiting: ${second.text}`);

    const game = second.json.game;
    assert(game && game.status === 'playing', `no playing game came back: ${second.text}`);
    assert(game.host.displayName === 'anna' && game.guest.displayName === 'bruno',
      `the pair is wrong, or the waiting player did not host: ${second.text}`);
    assert(/^[A-Z]+-\d{4}$/.test(game.seed), `no server-issued seed: ${second.text}`);
    assert(second.json.queue.count === 0, `the queue did not empty: ${second.text}`);

    // The waiting player learns the same thing from the API as the one who was told.
    const fromFirst = await call('GET', '/api/games/' + game.id, { as: 'a' });
    assert(fromFirst.status === 200 && fromFirst.json.game.seed === game.seed,
      `the two players do not agree on the game: ${fromFirst.text}`);
    const waiting = await call('GET', '/api/lobby', { as: 'a' });
    assert(waiting.json.you.waiting === false && waiting.json.you.game.id === game.id,
      `the first player's own state is wrong: ${waiting.text}`);
    return `both matched into game ${game.id} (seed ${game.seed}), "anna" hosted as the earlier waiter, queue empty`;
  });

  await check('10. leaving the queue removes the waiting state [brief 8]', async () => {
    // The queue has to start empty for "E is waiting" to mean anything: an earlier check
    // leaving somebody in it would show up here as an immediate match instead.
    const before = await call('GET', '/api/lobby', { as: 'e' });
    assert(before.json.queue.count === 0, `the queue was not empty to begin with: ${before.text}`);

    const joined = await call('POST', '/api/queue', { as: 'e' });
    assert(joined.json.waiting === true, `E is not waiting: ${joined.text}`);
    assert(joined.json.queue.count === 1, `the queue depth is wrong: ${joined.text}`);

    const left = await call('DELETE', '/api/queue', { as: 'e' });
    assert(left.status === 200, `leaving the queue returned ${left.status} ${left.text}`);
    assert(left.json.waiting === false, `E is still waiting: ${left.text}`);
    assert(left.json.queue.count === 0, `the queue still has somebody in it: ${left.text}`);

    const lobby = await call('GET', '/api/lobby', { as: 'e' });
    assert(lobby.json.you.waiting === false, `the lobby still says E is waiting: ${lobby.text}`);

    const again = await call('DELETE', '/api/queue', { as: 'e' });
    assert(again.status === 200 && again.json.waiting === false,
      `leaving twice is not idempotent: ${again.status} ${again.text}`);
    return `waiting -> 200 false, queue depth 1 -> 0, leaving again is still 200`;
  });

  await check('11. GET /api/games/:id is 403 for a non-participant [brief 9]', async () => {
    const asStranger = await call('GET', `/api/games/${state.playedGame.id}`, { as: 'c' });
    assert(asStranger.status === 403, `a stranger read a game (${asStranger.status} ${asStranger.text})`);
    assert(asStranger.json.error === 'not_your_game', `unexpected error code: ${asStranger.text}`);
    assert(!asStranger.text.includes(state.playedGame.seed),
      `the 403 leaked the seed anyway: ${asStranger.text}`);

    for (const key of ['a', 'b']) {
      const res = await call('GET', `/api/games/${state.playedGame.id}`, { as: key });
      assert(res.status === 200, `${key} is a participant and got ${res.status} ${res.text}`);
    }
    const missing = await call('GET', '/api/games/99999', { as: 'a' });
    assert(missing.status === 404 && missing.json.error === 'no_such_game',
      `a missing game returned ${missing.status} ${missing.text}`);
    return `403 not_your_game for C (no seed in the body), 200 for both participants, 404 for a missing id`;
  });

  await check('12. SSE: hello, then a lobby event when somebody hosts, then match [brief 10]', async () => {
    // Two tabs for one player: every one of them has to update, not just the newest.
    const tabOne = openStream('s');
    const tabTwo = openStream('s');
    await Promise.all([tabOne.opened, tabTwo.opened]);
    for (const tab of [tabOne, tabTwo]) {
      assert(tab.status === 200, `the stream answered ${tab.status}: ${tab.error}`);
      assert(/^text\/event-stream/.test(tab.contentType || ''), `the stream is ${tab.contentType}`);
    }

    const hello = await tabOne.waitFor('hello');
    assert(hello.you.player.displayName === 'sasha', `hello has the wrong player: ${JSON.stringify(hello)}`);
    assert(Array.isArray(hello.games), `hello has no games list: ${JSON.stringify(hello)}`);
    await tabTwo.waitFor('hello');

    // Somebody else hosts: both tabs see the new game in the open list.
    const hosted = await call('POST', '/api/games', { as: 'h' });
    assert(hosted.status === 201, `H could not host: ${hosted.status} ${hosted.text}`);
    const newGameId = hosted.json.game.id;
    for (const tab of [tabOne, tabTwo]) {
      const lobby = await tab.waitFor('lobby', (data) => data.games.some((game) => game.id === newGameId));
      const listed = lobby.games.find((game) => game.id === newGameId);
      assert(listed.host.displayName === 'hana', `the streamed host is wrong: ${JSON.stringify(lobby)}`);
    }

    // S joins the queue: its own tabs are told, and the shared count moves.
    const queued = await call('POST', '/api/queue', { as: 's' });
    assert(queued.json.waiting === true, `S did not queue: ${queued.text}`);
    const queueEvent = await tabOne.waitFor('queue', (data) => data.waiting === true);
    assert(queueEvent.queue.count === 1, `the queue event has the wrong depth: ${JSON.stringify(queueEvent)}`);

    // Somebody else queues: both are matched, and the waiting player is told on every tab.
    const matched = await call('POST', '/api/queue', { as: 'i' });
    assert(matched.json.waiting === false, `I did not match with S: ${matched.text}`);
    for (const tab of [tabOne, tabTwo]) {
      const match = await tab.waitFor('match');
      assert(match.game.id === matched.json.game.id, `the streamed match is the wrong game: ${JSON.stringify(match)}`);
      assert(match.game.status === 'playing' && match.game.seed === matched.json.game.seed,
        `the streamed match is not the game that was made: ${JSON.stringify(match)}`);
      assert(match.game.host.displayName === 'sasha' && match.game.guest.displayName === 'ivan',
        `the streamed pair is wrong: ${JSON.stringify(match)}`);
    }

    // The keepalive is what stops an idle proxy from closing a quiet stream.
    const comment = await tabOne.waitForComment();
    assert(comment === 'keepalive', `unexpected comment: "${comment}"`);

    await waitForStreamCount(server, 2);
    return `2 tabs: hello, a lobby event naming "hana"'s game, a queue event, a match event on both, keepalive "${comment}"`;
  });

  await check('13. disconnecting a stream cleans up its subscription (server-side count) [brief 11]', async () => {
    assert(lastStreamCount(server) === 2, `expected 2 open streams before the disconnect, log says ${lastStreamCount(server)}`);

    for (const stream of state.streams) stream.close();
    await waitForStreamCount(server, 0);
    state.streamsClosed = state.streams.splice(0, state.streams.length);

    // The count is the server's own: the line it logs on each connect and disconnect.
    const line = server.logs.join('').trim().split('\n').filter((entry) => /stream (?:open|close)/.test(entry)).pop();
    return `the server logged "${line.replace(/^\S+ /, '')}" — subscriptions back to 0`;
  });

  await check('14. a dropped stream gives up its queue place and its open game', async () => {
    const stream = openStream('g');
    await stream.opened;
    await stream.waitFor('hello');

    const queued = await call('POST', '/api/queue', { as: 'g' });
    assert(queued.json.waiting === true, `G did not queue: ${queued.text}`);
    const hosted = await call('POST', '/api/games', { as: 'g' });
    assert(hosted.status === 201, `G could not host: ${hosted.status} ${hosted.text}`);
    const gameId = hosted.json.game.id;

    const before = await call('GET', '/api/lobby', { as: 'c' });
    assert(before.json.queue.count === 1 && before.json.games.some((game) => game.id === gameId),
      `G's queue entry and game are not visible: ${before.text}`);

    // The tab closes. The grace period exists so that a reconnect can happen first, so
    // the cleanup is polled for rather than expected immediately.
    stream.close();
    await waitForStreamCount(server, 0);

    const deadline = Date.now() + 6000;
    let after = null;
    while (Date.now() < deadline) {
      after = await call('GET', '/api/lobby', { as: 'c' });
      const clean = after.json.queue.count === 0 && !after.json.games.some((game) => game.id === gameId);
      if (clean) break;
      await sleep(50);
    }
    assert(after.json.queue.count === 0, `the queue still holds G after the disconnect: ${after.text}`);
    assert(!after.json.games.some((game) => game.id === gameId),
      `G's game is still in the lobby after the disconnect: ${after.text}`);
    const gone = await call('GET', `/api/games/${gameId}`, { as: 'g' });
    assert(gone.status === 404, `G's game survived the disconnect (${gone.status})`);
    return `stream dropped -> queue depth 1 -> 0, game ${gameId} cancelled, inside the ${STREAM_GRACE_MS}ms grace`;
  });

  await check('15. no response contains another player\'s email, and displayName is always there [brief 12]', async () => {
    const emails = Object.values(PLAYERS);
    let checked = 0;
    for (const response of state.responses) {
      for (const email of emails) {
        if (email === response.as) continue; // your own address, in your own session response
        assert(!response.text.includes(email),
          `${response.method} ${response.path} (as ${response.as || 'nobody'}) contains ${email}: ${response.text.slice(0, 200)}`);
      }
      checked++;
    }
    assert(checked > 40, `only ${checked} responses were recorded — this check would be vacuous`);

    // Every stream event too: the lobby payload names other players, so it is the place
    // an address could escape from without any endpoint being wrong.
    let events = 0;
    for (const stream of state.streamsClosed) {
      for (const email of emails) {
        if (email === state.players[stream.key].email) continue;
        assert(!stream.text.includes(email), `the ${stream.key} stream carried ${email}`);
      }
      events += stream.events.length;
    }
    assert(events > 0, 'no stream events were recorded — that half of this check would be vacuous');

    // A player is named in exactly two fields, and the API never carries an address at
    // all — not even your own, which is what would make a leak a matter of time.
    let named = 0;
    for (const response of state.responses) {
      if (!/^\/api\/(lobby|games|queue|stream)/.test(response.path)) continue;
      assert(!/"email"/.test(response.text), `${response.method} ${response.path} carries an email field: ${response.text.slice(0, 200)}`);
      if (/"displayName"/.test(response.text)) named++;
    }
    assert(named > 0, 'no response named a player at all — displayName is missing');
    return `${checked} responses and ${events} stream events checked against ${emails.length} addresses; ${named} carried displayName and none carried an email field`;
  });

  await check('16. game creation and queue entry are rate limited, on their own windows', async () => {
    // Hosting first, as C — who ends this half of the check hosting a game. It is an
    // attempt either way: the limiter counts before the handler runs, which is the point
    // of counting there, so 201 and 409 both count.
    let gamesRejected = null;
    while (state.attempts.games < GAMES_MAX + 5) {
      const res = await call('POST', '/api/games', { as: 'c' });
      if (res.status === 429) { gamesRejected = res; break; }
      assert(res.status === 201 || res.status === 409, `expected 201, 409 or 429, got ${res.status} ${res.text}`);
    }
    assert(gamesRejected !== null, `no 429 in ${GAMES_MAX + 5} attempts (the limit is ${GAMES_MAX})`);
    assert(state.attempts.games === GAMES_MAX + 1,
      `the 429 arrived on game attempt ${state.attempts.games}, expected ${GAMES_MAX + 1}`);
    assert(gamesRejected.json.error === 'rate_limited', `unexpected body: ${gamesRejected.text}`);
    const retryAfter = gamesRejected.headers.get('retry-after');
    assert(Number(retryAfter) > 0, `no usable Retry-After on the 429: ${retryAfter}`);

    // A separate bucket, and a player who is not hosting anything: exhausting game
    // creation must not lock anybody out of the quick-match queue. E ends up waiting,
    // which the delete below undoes.
    let queueRejected = null;
    while (state.attempts.queue < QUEUE_MAX + 5) {
      const res = await call('POST', '/api/queue', { as: 'e' });
      if (res.status === 429) { queueRejected = res; break; }
      assert(res.status === 200 && res.json.waiting === true, `expected a waiting 200 or a 429, got ${res.status} ${res.text}`);
    }
    assert(queueRejected !== null, `no 429 in ${QUEUE_MAX + 5} queue attempts (the limit is ${QUEUE_MAX})`);
    assert(state.attempts.queue === QUEUE_MAX + 1,
      `the 429 arrived on queue attempt ${state.attempts.queue}, expected ${QUEUE_MAX + 1}`);
    assert(queueRejected.json.error === 'rate_limited', `unexpected body: ${queueRejected.text}`);
    await call('DELETE', '/api/queue', { as: 'e' });
    return `429 on game attempt ${GAMES_MAX + 1} and queue attempt ${QUEUE_MAX + 1}, Retry-After ${retryAfter}s, separate buckets`;
  });
  await check('17. a player cannot hold more streams than the server allows', async () => {
    // An event stream is a socket held open until the browser goes away, so the number of
    // them one account may hold has to be bounded somewhere. C has no streams of its own
    // at this point.
    const opened = [];
    for (let i = 0; i < STREAMS_MAX; i++) {
      const stream = openStream('c');
      opened.push(stream);
      await stream.opened;
      assert(stream.status === 200, `stream ${i + 1} of ${STREAMS_MAX} answered ${stream.status}: ${stream.error}`);
    }

    const extra = await fetch(`${state.base}/api/stream`, { headers: { Cookie: cookieFor('c') } });
    const body = await extra.text();
    assert(extra.status === 503, `stream ${STREAMS_MAX + 1} answered ${extra.status}, expected 503`);
    assert(/"too_many_streams"/.test(body), `unexpected body: ${body}`);
    assert(Number(extra.headers.get('retry-after')) > 0, 'the 503 has no usable Retry-After');
    assert(/^application\/json/.test(extra.headers.get('content-type') || ''),
      `a refused stream answered ${extra.headers.get('content-type')} rather than JSON, which a browser would retry forever`);

    for (const stream of opened) stream.close();
    await waitForStreamCount(server, 0);
    return `${STREAMS_MAX} streams accepted, the next refused with 503 too_many_streams (Retry-After ${extra.headers.get('retry-after')}s), then all released`;
  });
}

/**
 * The abandoned-game sweep, which needs its own server: the window it measures is minutes
 * in any real deployment, and a suite that waited for one would not be run.
 */
async function runSweepChecks() {
  await check('18. a game nobody is connected to is swept, so no player stays stranded in one', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanks-evolved-sweep-'));
    const server = startServer(Object.assign({}, process.env, {
      PORT: '0',
      HOST: '127.0.0.1',
      TANKS_DB: path.join(dataDir, 'tanks.db'),
      TANKS_SECURE_COOKIES: '0',
      TANKS_REGISTER_MAX: String(REGISTER_MAX),
      TANKS_STREAM_KEEPALIVE_MS: String(STREAM_KEEPALIVE_MS),
      TANKS_ABANDON_MS: '1000',
      TANKS_SWEEP_MS: '250'
    }));

    const outerBase = state.base;
    try {
      state.base = await waitForListen(server);

      const one = await call('POST', '/api/auth/register', { json: { email: 'quinn@example.com', password: PASSWORD } });
      const two = await call('POST', '/api/auth/register', { json: { email: 'rosa@example.com', password: PASSWORD } });
      const oneToken = tokenOf(one);
      const twoToken = tokenOf(two);

      const first = await fetch(`${state.base}/api/queue`, { method: 'POST', headers: { Cookie: `${COOKIE_NAME}=${oneToken}` } });
      const firstBody = await first.json();
      const second = await fetch(`${state.base}/api/queue`, { method: 'POST', headers: { Cookie: `${COOKIE_NAME}=${twoToken}` } });
      const secondBody = await second.json();
      assert(firstBody.waiting === true, `the first player did not wait: ${JSON.stringify(firstBody)}`);
      const gameId = secondBody.game && secondBody.game.id;
      assert(Number.isInteger(gameId), `no game was made: ${JSON.stringify(secondBody)}`);

      const alive = await fetch(`${state.base}/api/games/${gameId}`, { headers: { Cookie: `${COOKIE_NAME}=${twoToken}` } });
      assert(alive.status === 200, `the game is not readable straight after the match (${alive.status})`);

      await sleep(2500);

      const swept = await fetch(`${state.base}/api/games/${gameId}`, { headers: { Cookie: `${COOKIE_NAME}=${twoToken}` } });
      assert(swept.status === 404, `the abandoned game ${gameId} survived the sweep (${swept.status})`);
      assert(/swept 1 abandoned game/.test(server.logs.join('')), `the sweep was not logged:\n${server.logs.join('')}`);

      // And the player who was waiting on it can queue again rather than being stuck.
      const requeued = await fetch(`${state.base}/api/queue`, { method: 'POST', headers: { Cookie: `${COOKIE_NAME}=${twoToken}` } });
      assert(requeued.status === 200, `a player could not queue again after the sweep (${requeued.status})`);
      await requeued.json();
      return `game ${gameId} was read back at 200 and gone (404) 2.5s later, logged as "swept 1 abandoned game"`;
    } finally {
      state.base = outerBase;
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

// --------------------------------------------------------------------- report
function report() {
  let failed = 0;
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
    if (result.detail) console.log(`      ${result.detail.replace(/\n/g, '\n      ')}`);
    if (!result.ok) failed++;
  }
  console.log('');
  console.log(`${results.length - failed}/${results.length} checks passed`);
  return failed;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanks-evolved-lobby-'));
  const env = Object.assign({}, process.env, {
    PORT: '0',
    HOST: '127.0.0.1',
    TANKS_DB: path.join(dataDir, 'tanks.db'),
    TANKS_SECURE_COOKIES: '0',
    TANKS_REGISTER_MAX: String(REGISTER_MAX),
    TANKS_LOGIN_MAX: String(LOGIN_MAX),
    TANKS_GAMES_MAX: String(GAMES_MAX),
    TANKS_QUEUE_MAX: String(QUEUE_MAX),
    TANKS_STREAM_GRACE_MS: String(STREAM_GRACE_MS),
    TANKS_STREAM_KEEPALIVE_MS: String(STREAM_KEEPALIVE_MS),
    TANKS_ABANDON_MS: String(ABANDON_MS),
    TANKS_SWEEP_MS: String(SWEEP_MS),
    TANKS_MAX_STREAMS_PER_USER: String(STREAMS_MAX)
  });

  console.log('Tanks Evolved — Phase 2 server acceptance (lobby, matchmaking, event stream)');
  console.log(`node ${process.version} · ${path.relative(REPO_ROOT, SERVER)} · database in ${dataDir}`);
  console.log('');

  const server = startServer(env);
  let stop = { code: null, signal: null, timedOut: true };

  try {
    try {
      state.base = await waitForListen(server);
    } catch (err) {
      results.push({ name: '0. the server starts and reports where it is listening', ok: false, detail: err.message });
      throw err;
    }
    results.push({
      name: '0. the server starts on an ephemeral port against a fresh database',
      ok: true,
      detail: `listening on ${state.base}`
    });

    await runChecks(server, dataDir);
    await runSweepChecks();
  } catch {
    // A failed start is already recorded; the suite's own checks come out as "not run".
  }

  // One stream left open on purpose: a stream is a request that never finishes, and a
  // shutdown has to be able to close one rather than waiting out its whole grace period.
  const lingering = openStream('d');
  await lingering.opened;
  await lingering.waitFor('hello');

  stop = await stopServer(server);

  await check('19. SIGTERM shuts down cleanly with an event stream still open', async () => {
    assert(!stop.timedOut, 'the server did not exit within 10s of SIGTERM');
    assert(stop.code === 0, `expected exit code 0, got ${stop.code} (signal ${stop.signal})`);
    const log = server.logs.join('');
    assert(/SIGTERM: shutting down/.test(log), `no shutdown log line:\n${log}`);
    assert(/shutdown complete/.test(log), 'the shutdown did not finish');
    return `SIGTERM with 1 stream open → exit code 0, database closed`;
  });

  await check('20. the log holds no password, token, cookie or email address', async () => {
    const log = server.logs.join('');
    assert(!/ERROR/.test(log), `the server logged an error:\n${log}`);
    assert(/POST \/api\/games 201/.test(log), `no game was logged:\n${log}`);
    assert(!log.includes(PASSWORD), 'the password appears in the server log');
    for (const player of Object.values(state.players)) {
      assert(!log.includes(player.token), 'a session token appears in the server log');
      assert(!log.includes(player.email), 'an email address appears in the server log');
    }
    assert(!log.includes(COOKIE_NAME), 'a cookie value appears in the server log');
    return `${log.split('\n').filter(Boolean).length} log lines, none containing a password, token, cookie or address`;
  });

  const failed = report();

  if (failed === 0) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } else {
    console.log(`\nthe database and the server log were left in ${dataDir} for inspection`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
