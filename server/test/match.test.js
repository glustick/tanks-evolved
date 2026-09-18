#!/usr/bin/env node
/**
 * server/test/match.test.js — Phase 3 acceptance: the networked match, over real HTTP.
 *
 * Like the two suites next to it, the server under test is the real one — spawned as a
 * child process on an ephemeral port against a database in a temporary directory — and
 * every request goes over the wire with fetch. Cookies are carried by hand.
 *
 * The first twelve checks are the protocol: turn ownership, the replay log, chat, results
 * and presence, each stated as the thing that must be true rather than as the status code
 * that happens to come back.
 *
 * The thirteenth is the one that matters, and the reason this phase is tractable at all.
 * Two simulated players drive the *real* simulation — js/ loaded into a vm context the way
 * tools/check-determinism.js loads it, including js/match.js, so the code applying a
 * relayed shot is the code that ships — and play a complete match by exchanging shots
 * through the API. After every single turn both machines' `TE.game.stateHash()` must be
 * identical and must equal the hash the server stored for that turn. A third simulated
 * client then rebuilds the final position from nothing but the seed and the stored shot
 * log, and has to arrive at the same hash. That is what "reconnect is a replay" means,
 * and it is checked by doing it rather than by asserting it.
 *
 * Where a check corresponds to an item in the Phase 3 brief:
 *
 *   brief 1  -> 1, 13    brief 5  -> 8, 9       brief 9  -> 13
 *   brief 2  -> 4, 13    brief 6  -> 13         brief 10 -> 13
 *   brief 3  -> 2, 3     brief 7  -> 5, 6       brief 11 -> 13
 *   brief 4  -> 5        brief 8  -> 11         brief 12 -> 2, 3, 10
 *
 * Check 7 is the rate limiting, which needs its own server so a small budget does not
 * starve the match in check 13; check 11 is the walkover, which needs the abandonment
 * window to be a second rather than thirty minutes. 14 and 15 are the shutdown and log
 * checks the other two suites also end with.
 *
 * Usage:  node server/test/match.test.js
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'index.js');
const REPO_ROOT = path.join(__dirname, '..', '..');
const JS_DIR = path.join(REPO_ROOT, 'js');

const COOKIE_NAME = 'te_session';
const PASSWORD = 'correct-horse-battery-4821';

// Distinct local parts, so a display name identifies a player unambiguously in a failure
// message.
const PLAYERS = {
  a: 'anna@example.com',
  b: 'bruno@example.com',
  c: 'chen@example.com',
  d: 'dana@example.com',
  e: 'eli@example.com',
  f: 'fran@example.com',
  g: 'gita@example.com',
  h: 'hana@example.com',
  // The two that play the whole match in check 13. Reserved for it, so no earlier check
  // has spent any of their shot budget.
  v: 'vera@example.com',
  w: 'wren@example.com',
  // The pair that drives: the validation in check 16 and the whole match with movement in
  // check 17. Reserved the same way, and for the same reason.
  m: 'mira@example.com',
  n: 'nils@example.com'
};

// Every limit is set here rather than assumed, because every request in this file comes
// from one address. The match needs room — a real one sends one shot per turn — so the
// budgets on the main server are generous, and the two that are *about* a limit get their
// own server with a small one.
const REGISTER_MAX = 40;
const LOGIN_MAX = 40;
const SHOTS_MAX = 400;
const CHAT_MAX = 200;
// The walkover window, on its own server (see runWalkoverChecks).
const WALKOVER_ABANDON_MS = 1500;
const WALKOVER_SWEEP_MS = 250;
const WALKOVER_GRACE_MS = 100;
// The rate-limit server's budgets, which the checks measure against.
const LIMITED_SHOTS_MAX = 4;
const LIMITED_CHAT_MAX = 3;

// Long enough that nothing is swept while the suite is running. A game that started
// minutes ago is not abandoned; this suite is not measuring the sweep.
const ABANDON_MS = 10 * 60 * 1000;
const SWEEP_MS = 60 * 1000;
const STREAM_KEEPALIVE_MS = 1000;

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
const state = {
  base: null,
  players: {},
  streams: [],
  attempts: {},
  /** A growing list of one-lined failures, so a match that diverges says where. */
  notes: []
};

function cookieFor(key) {
  const player = state.players[key];
  if (!player) throw new Error(`no session for player ${key} — was the registration skipped?`);
  return `${COOKIE_NAME}=${player.token}`;
}

/**
 * One request, as one player or as nobody.
 *
 * Every shot and chat attempt is counted per player, because that is the unit both
 * limiters key on — see ratelimit.js.
 */
async function call(method, target, options = {}) {
  if (method === 'POST' && options.as) {
    if (/\/shot$/.test(target)) bump('shots', options.as);
    if (/\/chat$/.test(target)) bump('chat', options.as);
  }

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
    // Not every response is JSON.
  }
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);

  return { status: res.status, headers: res.headers, text, json, setCookies };
}

function bump(counter, key) {
  if (!state.attempts[counter]) state.attempts[counter] = {};
  state.attempts[counter][key] = (state.attempts[counter][key] || 0) + 1;
}

function attemptsOf(counter, key) {
  return (state.attempts[counter] && state.attempts[counter][key]) || 0;
}

function tokenOf(response) {
  const cookie = response.setCookies.find((entry) => entry.startsWith(`${COOKIE_NAME}=`)) || null;
  return cookie === null ? null : cookie.slice(COOKIE_NAME.length + 1).split(';')[0];
}

async function register(key) {
  const res = await call('POST', '/api/auth/register', { json: { email: PLAYERS[key], password: PASSWORD } });
  assert(res.status === 201, `registering ${PLAYERS[key]} returned ${res.status} ${res.text}`);
  state.players[key] = { email: PLAYERS[key], id: res.json.user.id, token: tokenOf(res) };
  return state.players[key];
}

/** Host a game as `host` and join it as `guest`, returning the playing game. */
async function pairUp(host, guest) {
  const hosted = await call('POST', '/api/games', { as: host });
  assert(hosted.status === 201, `${host} could not host: ${hosted.status} ${hosted.text}`);

  const joined = await call('POST', `/api/games/${hosted.json.game.id}/join`, { as: guest });
  assert(joined.status === 200, `${guest} could not join: ${joined.status} ${joined.text}`);
  assert(joined.json.game.status === 'playing', `the game is not playing: ${joined.text}`);
  return joined.json.game;
}

// ------------------------------------------------------------- event streams
/** Read one Server-Sent Events response as it arrives, the way lobby.test.js does. */
function openStream(key) {
  const controller = new AbortController();
  const stream = { key, events: [], status: null, error: null, text: '' };

  function ingest(block) {
    let name = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data.length === 0) return;
    try {
      stream.events.push({ name, data: JSON.parse(data) });
    } catch (err) {
      throw new Error(`the stream sent unparseable data for ${name}: ${data}`);
    }
  }

  stream.opened = fetch(`${state.base}/api/stream`, {
    headers: { Cookie: cookieFor(key) },
    signal: controller.signal
  }).then((res) => {
    stream.status = res.status;
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
      buffer = blocks.pop();
      for (const block of blocks) ingest(block);
      return pump();
    }).catch(() => undefined);
    pump();
    return undefined;
  }).catch((err) => {
    stream.error = (err && err.message) || String(err);
  });

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

  stream.close = () => controller.abort();
  state.streams.push(stream);
  return stream;
}

// ------------------------------------------------------------- the simulation
/**
 * The files a networked client needs, in the order index.html loads them. js/match.js is
 * in the list on purpose: the shot relay in check 13 is applied by the shipped client
 * code rather than by a copy of it written inside this test, so what passes here is what
 * runs in a browser.
 */
const SIM_MODULES = ['version.js', 'utils.js', 'terrain.js', 'physics.js', 'tanks.js', 'game.js', 'match.js'];

/** One simulated player: its own vm context, its own TE, its own board. */
function makeClient(seed) {
  const sandbox = { console };
  const context = vm.createContext(sandbox);
  for (const file of SIM_MODULES) {
    const code = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
    new vm.Script(code, { filename: `js/${file}` }).runInContext(context);
  }
  return { TE: context.TE, game: context.TE.game.create(seed) };
}

/**
 * Apply one relayed shot exactly as js/match.js does — and by calling it rather than by
 * reimplementing it, so this file cannot quietly disagree with the client.
 *
 * The returned string is the fingerprint of the board with the shot's aim applied and the
 * shell not yet fired, which is the value the shooter reported and the value the server
 * stored. Both clients computing the same one is the whole claim of the phase.
 */
function applyShot(client, shot) {
  return client.TE.match.applyShot(client.game, shot);
}

function stateHash(client) {
  return client.TE.game.stateHash(client.game);
}

/**
 * Aim at the other tank, searching a coarse grid with the real projectile integrator and
 * then refining around the best candidate.
 *
 * This is the *shooter's* local decision — nothing about it is relayed beyond the angle
 * and power it settles on — so all it has to do is end the match, reproducibly.
 *
 * `wanted` is how far short of the target to aim. Zero is a bullseye, which kills a tank
 * in two shots and ends the match in three turns — far too little of the relay to be
 * evidence of anything. A grazing hit has to be aimed, relayed, applied and fingerprinted
 * just the same, and takes a dozen turns to end the match, so the search scores a
 * candidate by how close its impact is to `wanted` rather than to the tank.
 *
 * The angle is set on the tank before each candidate is evaluated, because setting it
 * moves the barrel: aiming from the previous muzzle would evaluate a shot starting from
 * somewhere the shell does not actually start. The caller sets the final angle again, so
 * the last thing this leaves behind is the aim it chose.
 */
function solveShot(client, wanted) {
  const world = client.game.world;
  const tank = world.tanks[world.activeIndex];
  const target = world.tanks[1 - world.activeIndex];
  const centre = client.TE.tank.bodyCenter(target);
  const opts = { maxTime: 14 };
  let best = null;

  function evaluate(angle, power) {
    client.TE.tank.setAngle(tank, angle);
    const muzzle = client.TE.tank.muzzle(tank);
    const event = client.TE.physics.simulateShot(world, {
      x: muzzle.x, y: muzzle.y, angle: angle, power: power,
      facing: tank.facing, ownerId: tank.id, wind: world.wind
    }, opts);
    const distance = client.TE.utils.dist(event.x, event.y, centre.x, centre.y);
    const score = Math.abs(distance - wanted);
    if (!best || score < best.score) best = { angle, power, distance, score };
  }

  for (let angle = 20; angle <= 80; angle += 5) {
    for (let power = 40; power <= 100; power += 5) evaluate(angle, power);
  }
  const coarse = best;
  const from = { angle: Math.max(0, coarse.angle - 4), power: Math.max(5, coarse.power - 4) };
  const to = { angle: Math.min(90, coarse.angle + 4), power: Math.min(100, coarse.power + 4) };
  for (let angle = from.angle; angle <= to.angle; angle += 2) {
    for (let power = from.power; power <= to.power; power += 2) evaluate(angle, power);
  }

  // Two decimals: the wire is JSON, and a rounded aim is what a drag on the canvas would
  // have produced anyway. Both clients receive the same number and clamp it identically.
  return {
    angle: Math.round(best.angle * 100) / 100,
    power: Math.round(best.power * 100) / 100,
    distance: best.distance
  };
}

// ---------------------------------------------------------------------- suite
async function runChecks(server) {
  let gameA = null;
  let streams = null;

  await check('1. a shot from the player whose turn it is is accepted and lands in the replay log [brief 1]', async () => {
    for (const key of Object.keys(PLAYERS)) await register(key);
    gameA = await pairUp('a', 'b');

    // Turn 1 is the host's: the host plays odd turns.
    const res = await call('POST', `/api/games/${gameA.id}/shot`, {
      as: 'a', json: { angle: 47.5, power: 82, stateHash: 'SIM|turn1|' + 'a'.repeat(30) }
    });
    assert(res.status === 201, `the host's first shot returned ${res.status} ${res.text}`);
    assert(res.json.shots.length === 1, `the payload does not carry the shot log: ${res.text}`);

    const shot = res.json.shots[0];
    assert(shot.turn === 1, `the shot was not recorded as turn 1: ${JSON.stringify(shot)}`);
    assert(shot.userId === state.players.a.id, `the shot is attributed to the wrong player: ${JSON.stringify(shot)}`);
    assert(shot.angle === 47.5 && shot.power === 82, `the aim was not stored exactly: ${JSON.stringify(shot)}`);

    const read = await call('GET', `/api/games/${gameA.id}`, { as: 'b' });
    assert(read.status === 200, `the opponent cannot read the game: ${read.status} ${read.text}`);
    assert(read.json.shots.length === 1 && read.json.shots[0].turn === 1,
      `the opponent does not see the shot: ${JSON.stringify(read.json.shots)}`);

    // The turn moved, and the server says whose it is — the opponent's.
    assert(read.json.turn === 2, `the turn did not advance: ${read.text}`);
    assert(read.json.activeUserId === state.players.b.id,
      `turn 2 does not belong to the guest: ${read.text}`);
    assert(read.json.game.status === 'playing', `the game is no longer playing: ${read.text}`);

    // And the host is told the same thing by the response to their own shot.
    assert(res.json.turn === 2 && res.json.activeUserId === state.players.b.id,
      `the shooter's own payload disagrees about the turn: ${res.text}`);
    return `turn 1 (47.5° / 82%) by "anna" accepted as 201, log has 1 shot, turn 2 belongs to "bruno"`;
  });

  await check('2. a shot from the player whose turn it is not is rejected with 409 [brief 3]', async () => {
    // It is turn 2, which is the guest's.
    const res = await call('POST', `/api/games/${gameA.id}/shot`, {
      as: 'a', json: { angle: 30, power: 50, stateHash: 'SIM|turn2|' + 'b'.repeat(30) }
    });
    assert(res.status === 409, `the wrong player's shot returned ${res.status} ${res.text}`);
    assert(res.json.error === 'not_your_turn', `unexpected error code: ${res.text}`);
    assert(/\bturn 2\b/.test(res.json.message), `the message does not name the turn: ${res.text}`);

    // The guest, whose turn it is, is not refused.
    const mine = await call('POST', `/api/games/${gameA.id}/shot`, {
      as: 'b', json: { angle: 40, power: 70, stateHash: 'SIM|turn2|' + 'c'.repeat(30) }
    });
    assert(mine.status === 201, `the player whose turn it is was refused: ${mine.status} ${mine.text}`);
    assert(mine.json.shots.length === 2, `the guest's shot did not land in the log: ${mine.text}`);
    return `409 ${res.json.error} ("${res.json.message}") for the host on turn 2, then 201 for the guest`;
  });

  await check('3. a second shot for the same turn is rejected, sequentially and under a double click [brief 3]', async () => {
    // Sequential: turn 2 has been played, so a repeat aim at it is refused and the log is
    // untouched. (The turn that has just passed never belongs to the player who played it,
    // so the refusal that fires is the ownership one — a turn cannot be played twice
    // because after the first shot it is not that player's turn any more.)
    const hashes = {
      angle: 55, power: 65, stateHash: 'SIM|turn2|' + 'd'.repeat(30)
    };
    const repeat = await call('POST', `/api/games/${gameA.id}/shot`, { as: 'b', json: hashes });
    assert(repeat.status === 409, `the repeated shot returned ${repeat.status} ${repeat.text}`);
    const log = await call('GET', `/api/games/${gameA.id}`, { as: 'a' });
    assert(log.json.shots.length === 2, `the repeated shot reached the log: ${log.text}`);
    const turns = log.json.shots.map((shot) => shot.turn);
    assert(new Set(turns).size === turns.length, `a turn appears twice in the log: ${turns.join(', ')}`);

    // Concurrent, which is the case the unique index exists for: two requests from the
    // player whose turn it is, both in flight at once. Exactly one may win.
    const pair = await Promise.all([1, 2].map(() => call('POST', `/api/games/${gameA.id}/shot`, {
      as: 'a', json: { angle: 60, power: 75, stateHash: 'SIM|turn3|' + 'e'.repeat(30) }
    })));
    const created = pair.filter((res) => res.status === 201);
    const refused = pair.filter((res) => res.status === 409);
    assert(created.length === 1, `two concurrent shots produced ${created.length} accepted (${pair.map((r) => r.status).join(', ')})`);
    assert(refused.length === 1, `two concurrent shots produced ${refused.length} refused (${pair.map((r) => r.status).join(', ')})`);

    const after = await call('GET', `/api/games/${gameA.id}`, { as: 'b' });
    const turnThrees = after.json.shots.filter((shot) => shot.turn === 3);
    assert(turnThrees.length === 1, `turn 3 has ${turnThrees.length} shots in the log: ${after.text}`);
    state.notes.push(`turn 3: the loser of the double click was told "${refused[0].json.message}"`);
    return `409 for the repeat (log still 2 shots), then 201 + 409 ${refused[0].json.error} from two at once, one turn-3 shot stored`;
  });

  await check('4. the stateHash is persisted and returned with the replay log [brief 2]', async () => {
    // A hash with non-ASCII in it, so "the exact string came back" also checks that the
    // body was measured in bytes and encoded once.
    const distinctive = 'SEED-1|aiming|turn4|wind0.42|t1:397.2,291.4|°';
    const res = await call('POST', `/api/games/${gameA.id}/shot`, {
      as: 'b', json: { angle: 25, power: 95, stateHash: distinctive }
    });
    assert(res.status === 201, `turn 4 was refused: ${res.status} ${res.text}`);

    const read = await call('GET', `/api/games/${gameA.id}`, { as: 'a' });
    const stored = read.json.shots.find((shot) => shot.turn === 4);
    assert(stored, `turn 4 is not in the replay log: ${read.text}`);
    assert(stored.stateHash === distinctive,
      `the hash did not come back unchanged:\n  sent: ${distinctive}\n  got:  ${stored.stateHash}`);

    // Every turn in the log carries one, and they are the values that were sent.
    for (const shot of read.json.shots) {
      assert(typeof shot.stateHash === 'string' && shot.stateHash.length > 0,
        `turn ${shot.turn} has no hash: ${JSON.stringify(shot)}`);
    }
    // And the players see the same log.
    const seenByOpponent = await call('GET', `/api/games/${gameA.id}`, { as: 'b' });
    assert(JSON.stringify(seenByOpponent.json.shots) === JSON.stringify(read.json.shots),
      'the two players are looking at different replay logs');
    return `${read.json.shots.length} turns, each with a hash; turn 4's non-ASCII hash round-tripped exactly`;
  });

  await check('5. chat is stored, returned in the game payload and broadcast on the stream [brief 4]', async () => {
    const tabA = openStream('a');
    const tabB = openStream('b');
    await Promise.all([tabA.opened, tabB.opened]);
    for (const tab of [tabA, tabB]) {
      assert(tab.status === 200, `the stream answered ${tab.status}: ${tab.error}`);
      await tab.waitFor('hello');
    }
    streams = { a: tabA, b: tabB };

    // Both players connected, so both seats read as present.
    const before = await call('GET', `/api/games/${gameA.id}`, { as: 'a' });
    assert(before.json.presence.host === true && before.json.presence.guest === true,
      `presence does not reflect two open streams: ${JSON.stringify(before.json.presence)}`);

    const sent = await call('POST', `/api/games/${gameA.id}/chat`, { as: 'a', json: { text: '  good luck \u2014 mind the wind  ' } });
    assert(sent.status === 201, `chat returned ${sent.status} ${sent.text}`);
    assert(sent.json.message.text === 'good luck \u2014 mind the wind',
      `the message was not trimmed or is not the one sent: ${sent.text}`);
    assert(sent.json.message.userId === state.players.a.id, `the message has the wrong author: ${sent.text}`);

    // The opponent is told on the stream, with the same object.
    const heard = await tabB.waitFor('chat');
    assert(heard.message.text === 'good luck \u2014 mind the wind',
      `the broadcast differs from the response: ${JSON.stringify(heard)}`);
    // And the sender's own tab, so a second tab of theirs is not a silent observer.
    const echoed = await tabA.waitFor('chat');
    assert(echoed.message.userId === state.players.a.id, `the sender was not told: ${JSON.stringify(echoed)}`);

    // A reply, so the history has two authors in it.
    const reply = await call('POST', `/api/games/${gameA.id}/chat`, { as: 'b', json: { text: 'wind is a myth' } });
    assert(reply.status === 201, `the reply returned ${reply.status} ${reply.text}`);
    await tabA.waitFor('chat', (data) => data.message.userId === state.players.b.id);

    // The history is in the game payload, oldest first — which is what a reconnecting
    // client reads instead of the events it missed.
    const read = await call('GET', `/api/games/${gameA.id}`, { as: 'b' });
    assert(read.json.messages.length === 2, `the chat history is not in the payload: ${read.text}`);
    assert(read.json.messages[0].text === 'good luck \u2014 mind the wind' &&
      read.json.messages[1].text === 'wind is a myth',
      `the history is out of order: ${JSON.stringify(read.json.messages)}`);
    assert(read.json.messages[0].createdAt <= read.json.messages[1].createdAt,
      'the two messages have no usable timestamps');
    state.chatCount = read.json.messages.length;
    return `2 messages stored and returned oldest-first, broadcast to both tabs, presence host+guest true`;
  });

  await check('6. empty or oversized chat is rejected [brief 4]', async () => {
    const attempts = [
      { text: '', code: 'empty_message', why: 'empty' },
      { text: '   \t  ', code: 'empty_message', why: 'whitespace only' },
      { text: 'x'.repeat(501), code: 'message_too_long', why: '501 characters' }
    ];
    for (const attempt of attempts) {
      const res = await call('POST', `/api/games/${gameA.id}/chat`, { as: 'a', json: { text: attempt.text } });
      assert(res.status === 400, `${attempt.why} returned ${res.status} ${res.text}`);
      assert(res.json.error === attempt.code, `${attempt.why} returned ${res.json.error}: ${res.text}`);
    }

    // No `text` field at all, and not a string.
    for (const body of [{}, { text: 42 }, { text: null }]) {
      const res = await call('POST', `/api/games/${gameA.id}/chat`, { as: 'a', json: body });
      assert(res.status === 400 && res.json.error === 'invalid_message',
        `${JSON.stringify(body)} returned ${res.status} ${res.text}`);
    }

    // Exactly at the cap is accepted: the bound is a limit, not a fence to stay behind.
    const longest = 'y'.repeat(500);
    const ok = await call('POST', `/api/games/${gameA.id}/chat`, { as: 'a', json: { text: longest } });
    assert(ok.status === 201, `a 500-character message was refused: ${ok.status} ${ok.text}`);

    const read = await call('GET', `/api/games/${gameA.id}`, { as: 'a' });
    assert(read.json.messages.length === state.chatCount + 1,
      `a rejected message was stored anyway: ${read.json.messages.length} messages`);
    return `400 empty_message for "" and whitespace, 400 message_too_long for 501, 400 invalid_message for no field, 201 at exactly 500`;
  });

  await check('8. both players reporting the same winner finishes the match [brief 5]', async () => {
    assert(streams, 'check 5 left no streams open, so the broadcasts cannot be checked here');
    const winnerId = state.players.a.id;
    const hash = 'FINAL|' + 'a'.repeat(40);

    const first = await call('POST', `/api/games/${gameA.id}/result`, {
      as: 'a', json: { winnerUserId: winnerId, stateHash: hash }
    });
    assert(first.status === 200, `the first report returned ${first.status} ${first.text}`);
    assert(first.json.agreed === false && first.json.waiting === true,
      `one report was accepted as a finished match: ${first.text}`);
    assert(first.json.game.status === 'playing', `the match ended on one report: ${first.text}`);

    // A repeat of the same report is not an error — a client that never saw its response
    // sends it again — and it does not count as the second player's.
    const again = await call('POST', `/api/games/${gameA.id}/result`, {
      as: 'a', json: { winnerUserId: winnerId, stateHash: hash }
    });
    assert(again.status === 200 && again.json.waiting === true,
      `re-sending the same report was not treated as a retry: ${again.status} ${again.text}`);

    const second = await call('POST', `/api/games/${gameA.id}/result`, {
      as: 'b', json: { winnerUserId: winnerId, stateHash: hash }
    });
    assert(second.status === 200, `the second report returned ${second.status} ${second.text}`);
    assert(second.json.agreed === true, `the agreement was not accepted: ${second.text}`);

    const finished = second.json.game;
    assert(finished.status === 'finished', `the match is not finished: ${JSON.stringify(finished)}`);
    assert(finished.winner && finished.winner.id === winnerId,
      `the winner is wrong or missing: ${JSON.stringify(finished.winner)}`);
    assert(finished.winner.displayName === 'anna', `the winner has no name to render: ${second.text}`);
    assert(typeof finished.finishedAt === 'number' && finished.finishedAt >= gameA.startedAt,
      `finishedAt is missing or impossible: ${second.text}`);
    assert(finished.desync === false, `an agreed result was flagged as a desync: ${second.text}`);

    // Both players were told, and both are in the lobby again: `you.game` is null the
    // moment the game stops being live.
    for (const key of ['a', 'b']) {
      await streams[key].waitFor('over', (data) => data.game.status === 'finished');
      const lobby = await call('GET', '/api/lobby', { as: key });
      assert(lobby.json.you.game === null, `${key} is still in a finished game: ${lobby.text}`);
    }
    const overEvent = await streams.a.waitFor('over');
    assert(overEvent.game.winner.id === winnerId, `the streamed result disagrees: ${JSON.stringify(overEvent.game.winner)}`);
    assert(overEvent.reason === 'result', `unexpected reason: ${JSON.stringify(overEvent.reason)}`);

    // And a shot into a finished match is refused by name rather than by silence.
    const late = await call('POST', `/api/games/${gameA.id}/shot`, {
      as: 'a', json: { angle: 45, power: 60, stateHash: 'too-late' }
    });
    assert(late.status === 409 && late.json.error === 'game_not_playing',
      `a shot into a finished match returned ${late.status} ${late.text}`);
    assert(/finished/.test(late.json.message), `the refusal does not say the match is over: ${late.text}`);
    return `first report 200 waiting, same report again 200 waiting, second 200 agreed — finished, winner "anna", both returned to the lobby`;
  });

  await check('9. the two players reporting different winners marks a desync and produces no winner [brief 2]', async () => {
    const game = await pairUp('c', 'd');

    const first = await call('POST', `/api/games/${game.id}/result`, {
      as: 'c', json: { winnerUserId: state.players.c.id, stateHash: 'FINAL|one' + 'x'.repeat(40) }
    });
    assert(first.status === 200 && first.json.waiting === true, `unexpected first report: ${first.text}`);

    const second = await call('POST', `/api/games/${game.id}/result`, {
      as: 'd', json: { winnerUserId: state.players.d.id, stateHash: 'FINAL|two' + 'y'.repeat(40) }
    });
    assert(second.status === 200, `the disagreement returned ${second.status} ${second.text}`);
    assert(second.json.agreed === false, `two different winners were accepted: ${second.text}`);
    assert(second.json.desync === true, `the disagreement was not flagged: ${second.text}`);
    assert(second.json.game.status === 'finished', `the match did not end: ${second.text}`);
    assert(second.json.game.winner === null, `a desync produced a winner: ${second.text}`);
    assert(second.json.game.desync === true, `the game row has no desync flag: ${second.text}`);

    const read = await call('GET', `/api/games/${game.id}`, { as: 'c' });
    assert(read.json.game.desync === true && read.json.game.winner === null,
      `the stored game disagrees with the response: ${read.text}`);
    assert(read.json.activeUserId === null, `a finished match still has a turn: ${read.text}`);

    // A player changing their own report would make "both agree" meaningless.
    const flip = await call('POST', `/api/games/${game.id}/result`, {
      as: 'c', json: { winnerUserId: state.players.c.id, stateHash: 'FINAL|one' + 'x'.repeat(40) }
    });
    assert(flip.status === 409, `a report into a finished match returned ${flip.status} ${flip.text}`);
    return `desync flagged, winner null, both players told; the match is finished rather than left playing`;
  });

  await check('10. a non-participant cannot post a shot, chat or a result [brief 12]', async () => {
    const game = await pairUp('f', 'g');
    const stranger = 'h';

    const shot = await call('POST', `/api/games/${game.id}/shot`, {
      as: stranger, json: { angle: 45, power: 60, stateHash: 'not-mine' }
    });
    const chat = await call('POST', `/api/games/${game.id}/chat`, { as: stranger, json: { text: 'hello?' } });
    const result = await call('POST', `/api/games/${game.id}/result`, {
      as: stranger, json: { winnerUserId: state.players.h.id, stateHash: 'not-mine' }
    });

    for (const [what, res] of [['shot', shot], ['chat', chat], ['result', result]]) {
      assert(res.status === 403, `${what} by a non-participant returned ${res.status} ${res.text}`);
      assert(res.json.error === 'not_your_game', `${what} returned ${res.json.error}: ${res.text}`);
    }
    // The refusals leak nothing about the match: not the seed, not the log.
    for (const res of [shot, chat, result]) {
      assert(!res.text.includes(game.seed), `a 403 leaked the seed: ${res.text}`);
    }

    // Nothing was written by any of them.
    const read = await call('GET', `/api/games/${game.id}`, { as: 'f' });
    assert(read.json.shots.length === 0 && read.json.messages.length === 0,
      `a refused request wrote something: ${read.text}`);
    assert(read.json.game.status === 'playing', `a refused result ended the match: ${read.text}`);

    // The participants themselves are not refused, which is what makes the 403s mean
    // something: the endpoints work, for the two people they belong to.
    const accepted = await call('POST', `/api/games/${game.id}/shot`, {
      as: 'f', json: { angle: 45, power: 60, stateHash: 'mine' + 'z'.repeat(20) }
    });
    assert(accepted.status === 201, `a participant was refused: ${accepted.status} ${accepted.text}`);

    // And a stranger cannot read it either, which is the same rule on the read path.
    const peek = await call('GET', `/api/games/${game.id}`, { as: stranger });
    assert(peek.status === 403 && !peek.text.includes(game.seed), `a stranger read the match: ${peek.status} ${peek.text}`);
    return `403 not_your_game for shot, chat and result (and for GET), nothing written, participants still accepted`;
  });

  await check('12. the shot log is ordered, complete and replayable [brief 9]', async () => {
    // gameA played turns 1, 2, 3 and 4 before it was finished; the log has to be exactly
    // that, in that order, once each — a gap would change whose turn every later shot was.
    const read = await call('GET', `/api/games/${gameA.id}`, { as: 'b' });
    const shots = read.json.shots;

    assert(shots.length === 4, `expected 4 shots, found ${shots.length}: ${read.text}`);
    for (let i = 0; i < shots.length; i++) {
      assert(shots[i].turn === i + 1, `shot ${i} is turn ${shots[i].turn}, expected ${i + 1}`);
      const expected = (i + 1) % 2 === 1 ? state.players.a.id : state.players.b.id;
      assert(shots[i].userId === expected,
        `turn ${shots[i].turn} was played by ${shots[i].userId}, expected ${expected}`);
      assert(Number.isFinite(shots[i].angle) && Number.isFinite(shots[i].power),
        `turn ${shots[i].turn} has an unusable aim: ${JSON.stringify(shots[i])}`);
      assert(typeof shots[i].stateHash === 'string' && shots[i].stateHash.length > 0,
        `turn ${shots[i].turn} has no hash to check a replay against`);
    }

    // The two players see the same log, and the finished game still serves it.
    const other = await call('GET', `/api/games/${gameA.id}`, { as: 'a' });
    assert(JSON.stringify(other.json.shots) === JSON.stringify(shots),
      'the two players see different logs');
    assert(other.json.game.status === 'finished', `the game is not the finished one: ${other.text}`);

    // A replay needs the seed and the aims and nothing else — so those are what the
    // payload has to carry.
    assert(typeof other.json.game.seed === 'string' && other.json.game.seed.length > 0,
      'a finished game has no seed to replay from');
    return `4 shots, turns 1..4 exactly once each, alternating host/guest, in order, same for both players`;
  });
}

/**
 * Check 13: a complete match, played through the server by two simulated clients.
 *
 * Everything about the phase that can be checked end to end is checked here, because this
 * is the only place both halves of the wire are real — the API the container serves, and
 * the simulation the browser runs, including js/match.js's own relay path.
 *
 * The loop is deliberately the shape a real turn has: the player whose turn it is decides
 * an aim and reports the board it is looking at, the server relays it, and *both* clients
 * apply the same shot with the same code. What is asserted is that the two fingerprints
 * are the same string after every turn and that the one stored for that turn is that
 * string — which is the phase's whole claim, stated as an equality rather than a promise.
 */
async function runFullMatch() {
  await check('13. two simulated clients play a whole match through the server and stay byte-identical [briefs 1-12]', async () => {
    // Registered with everybody else in check 1, and reserved since: their shot budget is
    // the one this check spends in full.
    const hostAccount = state.players.v;
    const guestAccount = state.players.w;
    assert(hostAccount && guestAccount, 'the two players reserved for the full match were never registered');

    const game = await pairUp('v', 'w');
    const seed = game.seed;

    // Two machines: separate vm contexts, separate boards, the same server-issued seed.
    const host = makeClient(seed);
    const guest = makeClient(seed);
    assert(stateHash(host) === stateHash(guest),
      'two clients on one seed disagree before a shot is fired');
    state.notes.push(`full match on seed ${seed}: ${stateHash(host).slice(0, 48)}…`);

    const MAX_TURNS = 40;
    // Aim to graze rather than to bullseye, so the match lasts long enough to be evidence
    // — and drop the handicap past turn 24 so a stubborn map still finishes. What is
    // being measured is the relay, not the solver, so the aim only has to be landed.
    const GRAZE = 36;
    const GRAZE_UNTIL_TURN = 24;
    let turns = 0;
    let agreedTurns = 0;
    let misses = 0;

    while (host.game.world.state !== 'over' && turns < MAX_TURNS) {
      const turn = turns + 1;
      const hostToPlay = turn % 2 === 1; // the host plays odd turns, as the server says
      const shooter = hostToPlay ? host : guest;
      const opponent = hostToPlay ? guest : host;
      const as = hostToPlay ? 'v' : 'w';

      // The shooter's own decision — nothing about it is relayed but the two numbers.
      const wanted = turn <= GRAZE_UNTIL_TURN ? GRAZE : 0;
      const aim = solveShot(shooter, wanted);
      const tank = shooter.game.world.tanks[shooter.game.world.activeIndex];
      shooter.TE.tank.setAngle(tank, aim.angle);
      shooter.TE.tank.setPower(tank, aim.power);
      const reported = stateHash(shooter);

      const res = await call('POST', `/api/games/${game.id}/shot`, {
        as, json: { angle: aim.angle, power: aim.power, stateHash: reported }
      });
      assert(res.status === 201, `turn ${turn} returned ${res.status} ${res.text}`);

      const stored = res.json.shots[res.json.shots.length - 1];
      assert(stored.turn === turn, `turn ${turn} was stored as turn ${stored.turn}`);
      assert(stored.userId === (hostToPlay ? hostAccount.id : guestAccount.id),
        `turn ${turn} is attributed to ${stored.userId}`);
      assert(stored.angle === aim.angle && stored.power === aim.power,
        `turn ${turn} lost the aim on the way through: sent ${aim.angle}/${aim.power}, stored ${stored.angle}/${stored.power}`);
      assert(stored.stateHash === reported,
        `turn ${turn} lost the hash: sent ${reported}\n  stored ${stored.stateHash}`);

      // Both machines apply it. The shooter is not a special case: same function, same
      // numbers, and the fingerprint it produces is the one that was stored.
      const onShooter = applyShot(shooter, stored);
      const onOpponent = applyShot(opponent, stored);
      assert(onShooter === stored.stateHash,
        `turn ${turn}: the shooter's own board did not reproduce the hash it reported`);
      assert(onOpponent === stored.stateHash,
        `turn ${turn}: the opponent's board diverged from the shooter's:\n  shooter:  ${onShooter}\n  opponent: ${onOpponent}`);

      // And after the turn has resolved, the two boards are the same board.
      assert(stateHash(host) === stateHash(guest),
        `after turn ${turn} the two clients disagree:\n  host:  ${stateHash(host)}\n  guest: ${stateHash(guest)}`);
      assert(host.game.turn === guest.game.turn && host.game.world.activeIndex === guest.game.world.activeIndex,
        `after turn ${turn} the two clients disagree about whose turn it is`);

      agreedTurns++;
      turns++;
      if (aim.distance > 70) misses++;
    }

    assert(host.game.world.state === 'over',
      `the match did not reach a win in ${MAX_TURNS} turns (${turns} played, ${host.game.world.shotCount} shots)`);
    assert(stateHash(host) === stateHash(guest), 'the two clients disagree about the final position');

    const winnerIndex = host.game.world.winner;
    assert(winnerIndex === 1 || winnerIndex === 2, `unexpected winner: ${winnerIndex}`);
    assert(guest.game.world.winner === winnerIndex, 'the two clients disagree about who won');
    const winnerUserId = winnerIndex === 1 ? hostAccount.id : guestAccount.id;
    const winnerName = winnerIndex === 1 ? 'vera' : 'wren';
    const finalHash = stateHash(host);

    // Both players report the same winner and the same board, which is what ends it.
    const first = await call('POST', `/api/games/${game.id}/result`, {
      as: 'v', json: { winnerUserId, stateHash: finalHash }
    });
    assert(first.status === 200 && first.json.waiting === true,
      `the first report returned ${first.status} ${first.text}`);

    const second = await call('POST', `/api/games/${game.id}/result`, {
      as: 'w', json: { winnerUserId, stateHash: finalHash }
    });
    assert(second.status === 200 && second.json.agreed === true,
      `the two clients agreed and the server did not accept it: ${second.status} ${second.text}`);
    assert(second.json.game.status === 'finished' && second.json.game.winner.id === winnerUserId,
      `the stored result is wrong: ${second.text}`);
    assert(second.json.game.desync === false, `an agreed match was flagged as a desync: ${second.text}`);

    // A third simulated client, with nothing but the seed and the stored log: the
    // reconnect path, played out rather than described.
    const rejoin = makeClient(seed);
    const read = await call('GET', `/api/games/${game.id}`, { as: 'v' });
    const log = read.json.shots;
    assert(log.length === turns, `the stored log has ${log.length} shots for ${turns} turns`);

    let replayed = 0;
    for (const shot of log) {
      assert(shot.stateHash && shot.stateHash.length > 0, `turn ${shot.turn} has no hash to check against`);
      const hash = applyShot(rejoin, shot);
      assert(hash === shot.stateHash,
        `replaying turn ${shot.turn} produced a different board than the server stored:\n  replayed: ${hash}\n  stored:   ${shot.stateHash}`);
      replayed++;
    }
    assert(replayed === turns, `replayed ${replayed} of ${turns} shots`);
    assert(stateHash(rejoin) === finalHash,
      `the replayed board is not the board the two players ended on:\n  replayed: ${stateHash(rejoin)}\n  played:   ${finalHash}`);

    // The reconnecting client also knows whose turn it would be, from the payload alone.
    assert(read.json.activeUserId === null, `a finished match still claims a turn: ${read.text}`);
    assert(read.json.turn === turns + 1, `the payload's turn is ${read.json.turn}, expected ${turns + 1}`);

    state.notes.push(`full match: ${turns} turns, ${winnerName} won as P${winnerIndex}, ` +
      `${agreedTurns} turns with identical hashes, ${misses} shots outside the blast radius, ` +
      `${replayed}-shot replay landed on the same hash`);
    return `seed ${seed}: ${turns} turns, every one byte-identical on both clients and equal to the stored hash; ` +
      `${winnerName} (P${winnerIndex}) accepted as the winner by both reports; a third client rebuilt the ` +
      `final position from the seed and the ${replayed}-shot log and matched (${finalHash.slice(0, 40)}…)`;
  });
}

/**
 * Check 7, which needs its own server: the budgets it measures are small on purpose, and
 * a small budget on the main server would starve the match in check 13.
 */
async function runLimitChecks() {
  await check('7. shots and chat are rate limited, per player and on separate windows [brief 4]', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanks-evolved-limits-'));
    const server = startServer(Object.assign({}, process.env, {
      PORT: '0',
      HOST: '127.0.0.1',
      TANKS_DB: path.join(dataDir, 'tanks.db'),
      TANKS_SECURE_COOKIES: '0',
      TANKS_REGISTER_MAX: String(REGISTER_MAX),
      TANKS_SHOTS_MAX: String(LIMITED_SHOTS_MAX),
      TANKS_CHAT_MAX: String(LIMITED_CHAT_MAX),
      TANKS_SHOTS_WINDOW_MS: '60000',
      TANKS_CHAT_WINDOW_MS: '60000',
      TANKS_ABANDON_MS: String(ABANDON_MS),
      TANKS_SWEEP_MS: String(SWEEP_MS)
    }));

    const outerBase = state.base;
    const outerAttempts = state.attempts;
    try {
      state.base = await waitForListen(server);
      state.attempts = {};
      await register('c');
      await register('d');
      const game = await pairUp('c', 'd');

      // The host spends their shot budget on turn 1 and then on refusals — an attempt is
      // an attempt, which is why the limiter is counted before the handler runs.
      let shotsRejected = null;
      while (attemptsOf('shots', 'c') < LIMITED_SHOTS_MAX + 3) {
        const res = await call('POST', `/api/games/${game.id}/shot`, {
          as: 'c', json: { angle: 45, power: 60, stateHash: 'rate-limit-probe' }
        });
        if (res.status === 429) { shotsRejected = res; break; }
        assert(res.status === 201 || res.status === 409, `expected 201, 409 or 429, got ${res.status} ${res.text}`);
      }
      assert(shotsRejected !== null, `no 429 in ${LIMITED_SHOTS_MAX + 3} shot attempts (limit ${LIMITED_SHOTS_MAX})`);
      assert(attemptsOf('shots', 'c') === LIMITED_SHOTS_MAX + 1,
        `the 429 arrived on attempt ${attemptsOf('shots', 'c')}, expected ${LIMITED_SHOTS_MAX + 1}`);
      assert(shotsRejected.json.error === 'rate_limited', `unexpected body: ${shotsRejected.text}`);
      const retryAfter = shotsRejected.headers.get('retry-after');
      assert(Number(retryAfter) > 0, `no usable Retry-After on the 429: ${retryAfter}`);

      // A separate key: the opponent's budget is their own, so one player spending theirs
      // does not stop the other playing. (It is the guest's turn by now.)
      const opponent = await call('POST', `/api/games/${game.id}/shot`, {
        as: 'd', json: { angle: 45, power: 60, stateHash: 'opponent-still-playing' }
      });
      assert(opponent.status === 201, `the opponent was limited by the host's spending: ${opponent.status} ${opponent.text}`);

      // A separate bucket: exhausting shots must not lock the player out of the chat.
      let chatRejected = null;
      while (attemptsOf('chat', 'c') < LIMITED_CHAT_MAX + 3) {
        const res = await call('POST', `/api/games/${game.id}/chat`, { as: 'c', json: { text: 'still here' } });
        if (res.status === 429) { chatRejected = res; break; }
        assert(res.status === 201, `expected a 201 or a 429, got ${res.status} ${res.text}`);
      }
      assert(chatRejected !== null, `no 429 in ${LIMITED_CHAT_MAX + 3} chat attempts (limit ${LIMITED_CHAT_MAX})`);
      assert(attemptsOf('chat', 'c') === LIMITED_CHAT_MAX + 1,
        `the chat 429 arrived on attempt ${attemptsOf('chat', 'c')}, expected ${LIMITED_CHAT_MAX + 1}`);
      assert(chatRejected.json.error === 'rate_limited', `unexpected body: ${chatRejected.text}`);

      // And the chat being exhausted does not silence the other player either.
      const otherChat = await call('POST', `/api/games/${game.id}/chat`, { as: 'd', json: { text: 'i am here' } });
      assert(otherChat.status === 201, `the opponent's chat was limited too: ${otherChat.status} ${otherChat.text}`);

      return `429 on shot attempt ${LIMITED_SHOTS_MAX + 1} and chat attempt ${LIMITED_CHAT_MAX + 1} (Retry-After ${retryAfter}s); ` +
        'the opponent and the other bucket unaffected';
    } finally {
      state.base = outerBase;
      state.attempts = outerAttempts;
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

/**
 * Check 11, which needs its own server for the same reason: the window it measures is
 * half an hour in any real deployment, and a suite that waited for one would not be run.
 */
async function runWalkoverChecks() {
  await check('11. a disconnect marks the player away and tells their opponent; the match is a walkover after the window [brief 8]', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanks-evolved-walkover-'));
    const server = startServer(Object.assign({}, process.env, {
      PORT: '0',
      HOST: '127.0.0.1',
      TANKS_DB: path.join(dataDir, 'tanks.db'),
      TANKS_SECURE_COOKIES: '0',
      TANKS_REGISTER_MAX: String(REGISTER_MAX),
      TANKS_STREAM_GRACE_MS: String(WALKOVER_GRACE_MS),
      TANKS_ABANDON_MS: String(WALKOVER_ABANDON_MS),
      TANKS_SWEEP_MS: String(WALKOVER_SWEEP_MS),
      TANKS_SHOTS_MAX: String(SHOTS_MAX),
      TANKS_CHAT_MAX: String(CHAT_MAX)
    }));

    const outerBase = state.base;
    try {
      state.base = await waitForListen(server);
      const home = await register('e');
      const leaver = await register('f');
      const game = await pairUp('e', 'f');

      const tabHome = openStream('e');
      const tabLeaver = openStream('f');
      await Promise.all([tabHome.opened, tabLeaver.opened]);
      await tabHome.waitFor('hello');
      await tabLeaver.waitFor('hello');

      const both = await call('GET', `/api/games/${game.id}`, { as: 'e' });
      assert(both.json.presence.host === true && both.json.presence.guest === true,
        `two connected players do not both read as present: ${JSON.stringify(both.json.presence)}`);

      // The leaver's tab goes away.
      tabLeaver.close();
      const away = await tabHome.waitFor('opponent', (data) => data.present === false);
      assert(away.userId === leaver.id, `the wrong player was reported away: ${JSON.stringify(away)}`);
      const whileAway = await tabHome.waitFor('game', (data) => data.presence.guest === false);
      assert(whileAway.game.status === 'playing',
        `a disconnect ended the match immediately: ${JSON.stringify(whileAway.game.status)}`);

      // Back inside the window: they are present again and the match is still on.
      const tabBack = openStream('f');
      await tabBack.opened;
      await tabBack.waitFor('hello');
      const back = await tabHome.waitFor('opponent', (data) => data.present === true);
      assert(back.userId === leaver.id, `the wrong player was reported back: ${JSON.stringify(back)}`);
      const stillPlaying = await call('GET', `/api/games/${game.id}`, { as: 'e' });
      assert(stillPlaying.json.game.status === 'playing',
        `a reconnect did not save the match: ${JSON.stringify(stillPlaying.json.game)}`);

      // Gone again, and this time for good. The sweep awards the match to the player who
      // stayed, rather than leaving two clients to invent an ending between them.
      tabBack.close();
      await tabHome.waitFor('opponent', (data) => data.present === false);
      const over = await tabHome.waitFor('over', (data) => data.reason === 'walkover', 10000);
      assert(over.game.status === 'finished', `the walkover did not finish the match: ${JSON.stringify(over.game)}`);
      assert(over.game.winner && over.game.winner.id === home.id,
        `the walkover went to the wrong player: ${JSON.stringify(over.game.winner)}`);
      assert(over.game.desync === false, `a walkover was flagged as a desync: ${JSON.stringify(over.game)}`);

      const read = await call('GET', `/api/games/${game.id}`, { as: 'e' });
      assert(read.json.game.status === 'finished' && read.json.game.winner.id === home.id,
        `the stored game does not match the event: ${read.text}`);
      const lobby = await call('GET', '/api/lobby', { as: 'f' });
      assert(lobby.json.you.game === null, `the player who left is still in the game: ${lobby.text}`);
      assert(/did not return/.test(server.logs.join('')), `the walkover was not logged:\n${server.logs.join('')}`);

      // The player who stayed can start again rather than being stranded in a match.
      const rehost = await call('POST', '/api/games', { as: 'e' });
      assert(rehost.status === 201, `the winner could not host again: ${rehost.status} ${rehost.text}`);

      return `away on disconnect (match still playing), present again on reconnect, then a walkover to "eli" ` +
        `${WALKOVER_ABANDON_MS}ms after the second drop — logged and stored, and the winner can host again`;
    } finally {
      state.base = outerBase;
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

/**
 * Checks 16 to 18: tank movement, over the same wire.
 *
 * The relay is the part of this that must not be wrong. A turn is now
 * `(move, angle, power, hash)` and the move has to travel the same path the aim does and
 * land in the same row, because a client that drove without the server knowing would
 * replay to a board of its own and be reported as a desync neither player caused. So 16
 * checks the shape of the wire, 17 checks that two machines replaying `(move, angle,
 * power)` stay byte-identical over a whole match — and that a third client with nothing
 * but the seed and the log rebuilds the same board — and 18 checks the one thing that
 * cannot be tested from scratch: a database that already holds shots written before the
 * move column existed.
 */
async function runMovementChecks() {
  // The simulation's own budget, read from the shipped constants rather than restated, so
  // the server's bound is checked against the number the clients actually play by.
  const MOVE_POINTS = makeClient('BUDGET-PROBE').TE.CONST.MOVE_POINTS;

  await check('16. a turn carries its driving: stored, relayed and bounded by the budget', async () => {
    const game = await pairUp('m', 'n');
    const tab = openStream('m');
    await tab.opened;
    assert(tab.status === 200, `the stream answered ${tab.status}: ${tab.error}`);

    // 1. Outside the budget is refused rather than clamped, and the client's budget is the
    //    bound: the server refuses the next point past it and nothing of the attempt is
    //    recorded. Clamping would be the worst of the three options — the shooter's board
    //    used its own number and the opponent's would use the server's.
    const past = MOVE_POINTS + 1;
    const refusals = [
      { move: past, why: 'one point past the budget' },
      { move: -past, why: 'one point past it backwards' },
      { move: 1000, why: 'absurdly far' },
      { move: -1000, why: 'absurdly far backwards' },
      { move: 2.5, why: 'not a whole number of points' },
      { move: '3', why: 'a string' }
    ];
    for (const attempt of refusals) {
      const res = await call('POST', `/api/games/${game.id}/shot`, {
        as: 'm', json: { move: attempt.move, angle: 45, power: 60, stateHash: 'probe-' + attempt.why }
      });
      assert(res.status === 400, `a move that is ${attempt.why} returned ${res.status} ${res.text}`);
      assert(res.json.error === 'invalid_move', `${attempt.why} was refused as "${res.json.error}"`);
    }
    const afterRefusals = await call('GET', `/api/games/${game.id}`, { as: 'm' });
    assert(afterRefusals.json.shots.length === 0,
      `${afterRefusals.json.shots.length} refused turns reached the replay log`);

    // 2. The whole budget is legal, and the move survives the wire, the log and the event.
    const first = await call('POST', `/api/games/${game.id}/shot`, {
      as: 'm', json: { move: MOVE_POINTS, angle: 41, power: 68, stateHash: 'MOVE|turn1|' + 'm'.repeat(20) }
    });
    assert(first.status === 201, `a full-budget drive was refused: ${first.status} ${first.text}`);
    assert(first.json.shots[0].move === MOVE_POINTS,
      `the drive did not survive the wire: ${JSON.stringify(first.json.shots[0])}`);
    assert(first.json.shots[0].angle === 41 && first.json.shots[0].power === 68,
      'the aim did not survive alongside it');

    const relayed = await tab.waitFor('shot');
    assert(relayed.shot.move === MOVE_POINTS,
      `the relayed turn lost the drive: ${JSON.stringify(relayed.shot)}`);

    // 3. Backwards is negative, and it is the opponent's turn now.
    const second = await call('POST', `/api/games/${game.id}/shot`, {
      as: 'n', json: { move: -3, angle: 30, power: 55, stateHash: 'MOVE|turn2|' + 'n'.repeat(20) }
    });
    assert(second.status === 201, `driving backwards was refused: ${second.status} ${second.text}`);
    assert(second.json.shots[1].move === -3, `the reverse did not survive: ${JSON.stringify(second.json.shots[1])}`);

    // 4. A turn with no move at all is a legal turn, and it is not the same thing as a
    //    clamp: a client from the deploy before this one sends no such field, and the turn
    //    it played is the turn it always played — the one where the tank did not drive.
    const legacy = await call('POST', `/api/games/${game.id}/shot`, {
      as: 'm', json: { angle: 50, power: 70, stateHash: 'MOVE|turn3|' + 'l'.repeat(20) }
    });
    assert(legacy.status === 201, `a turn with no move field was refused: ${legacy.status} ${legacy.text}`);
    assert(legacy.json.shots[2].move === 0,
      `a turn with no move was recorded as ${JSON.stringify(legacy.json.shots[2].move)}`);

    // And the opponent sees the same log, driving and all.
    const read = await call('GET', `/api/games/${game.id}`, { as: 'n' });
    assert(read.json.shots.map((s) => s.move).join(',') === `${MOVE_POINTS},-3,0`,
      `the log the opponent reads is ${JSON.stringify(read.json.shots.map((s) => s.move))}`);
    for (const shot of read.json.shots) {
      assert(typeof shot.move === 'number' && Number.isInteger(shot.move),
        `turn ${shot.turn} has no usable move: ${JSON.stringify(shot)}`);
    }
    tab.close();

    return `budget ${MOVE_POINTS} points: ${refusals.length} out-of-budget drives refused as ` +
      'invalid_move with nothing written, a full-budget drive and a reverse stored and relayed ' +
      'verbatim, and a turn with no move field accepted as 0';
  });

  await check('17. two simulated clients play a whole match with driving and stay byte-identical', async () => {
    const hostAccount = state.players.m;
    const guestAccount = state.players.n;
    assert(hostAccount && guestAccount, 'the two players reserved for the driven match were never registered');

    const game = await pairUp('m', 'n');
    const seed = game.seed;

    const host = makeClient(seed);
    const guest = makeClient(seed);
    assert(stateHash(host) === stateHash(guest), 'two clients on one seed disagree before a turn is played');

    // A drive schedule that is varied, deterministic, and comes back to where it started:
    // forward, back, still, a step each way. Net zero over five turns, so the tanks stay
    // near the ground they spawned on and the match is still a match — what is being
    // measured is the relay, not what driving does to a firing line.
    const SCHEDULE = [2, -2, 0, 1, -1];
    const MAX_TURNS = 44;
    const GRAZE = 36;
    const GRAZE_UNTIL_TURN = 14;

    let turns = 0;
    let drives = 0;
    const movesUsed = new Set();

    while (host.game.world.state !== 'over' && turns < MAX_TURNS) {
      const turn = turns + 1;
      const hostToPlay = turn % 2 === 1;
      const shooter = hostToPlay ? host : guest;
      const opponent = hostToPlay ? guest : host;
      const as = hostToPlay ? 'm' : 'n';
      const move = SCHEDULE[turns % SCHEDULE.length];

      // The drive happens on the shooter's own board first, exactly as it does in the
      // browser: the player has to see where they are firing from, and the aim is chosen
      // from there. Nothing about this is relayed but the number of points it cost.
      shooter.TE.game.applyMove(shooter.game, move);
      const moved = shooter.game.world.tanks[shooter.game.world.activeIndex].x;
      const wanted = turn <= GRAZE_UNTIL_TURN ? GRAZE : 0;
      const aim = solveShot(shooter, wanted);
      const tank = shooter.game.world.tanks[shooter.game.world.activeIndex];
      shooter.TE.tank.setAngle(tank, aim.angle);
      shooter.TE.tank.setPower(tank, aim.power);
      const reported = stateHash(shooter);

      const res = await call('POST', `/api/games/${game.id}/shot`, {
        as, json: { move: move, angle: aim.angle, power: aim.power, stateHash: reported }
      });
      assert(res.status === 201, `turn ${turn} returned ${res.status} ${res.text}`);

      const stored = res.json.shots[res.json.shots.length - 1];
      assert(stored.turn === turn, `turn ${turn} was stored as turn ${stored.turn}`);
      assert(stored.move === move, `turn ${turn} lost its ${move} points of driving on the way through: ${res.text}`);
      assert(stored.angle === aim.angle && stored.power === aim.power,
        `turn ${turn} lost the aim: sent ${aim.angle}/${aim.power}, stored ${stored.angle}/${stored.power}`);
      assert(stored.stateHash === reported, `turn ${turn} lost the hash: sent ${reported}\n  stored ${stored.stateHash}`);

      // Both machines apply the turn — the shooter's board, which has already driven, and
      // the opponent's, which has not. One function, the same numbers, the same fingerprint.
      const onShooter = applyShot(shooter, stored);
      const onOpponent = applyShot(opponent, stored);
      assert(onShooter === stored.stateHash,
        `turn ${turn}: the shooter's own board did not reproduce the hash it reported`);
      assert(onOpponent === stored.stateHash,
        `turn ${turn}: the opponent's board diverged from the shooter's:\n  shooter:  ${onShooter}\n  opponent: ${onOpponent}`);

      assert(stateHash(host) === stateHash(guest),
        `after turn ${turn} the two clients disagree:\n  host:  ${stateHash(host)}\n  guest: ${stateHash(guest)}`);
      assert(host.game.turn === guest.game.turn && host.game.world.activeIndex === guest.game.world.activeIndex,
        `after turn ${turn} the two clients disagree about whose turn it is`);
      assert(host.game.world.tanks[0].x === guest.game.world.tanks[0].x &&
        host.game.world.tanks[1].x === guest.game.world.tanks[1].x,
        `after turn ${turn} the two clients have their tanks in different places`);
      if (move !== 0) {
        assert(moved !== null, 'the drive check read a null position');
        drives++;
      }
      movesUsed.add(move);
      turns++;
    }

    assert(turns >= 3, `the match only lasted ${turns} turns — not enough relay to be evidence`);
    assert(host.game.world.state === 'over',
      `the match did not reach a win in ${MAX_TURNS} turns (${turns} played, ${host.game.world.shotCount} shots)`);
    assert(stateHash(host) === stateHash(guest), 'the two clients disagree about the final position');
    assert(drives > 0, 'not one turn of the match actually drove anywhere');
    assert(movesUsed.has(0) && movesUsed.has(2) && movesUsed.has(-2),
      `the schedule did not exercise forward, backward and still: ${[...movesUsed].join(', ')}`);

    const winnerIndex = host.game.world.winner;
    assert(winnerIndex === 1 || winnerIndex === 2, `unexpected winner: ${winnerIndex}`);
    const winnerUserId = winnerIndex === 1 ? hostAccount.id : guestAccount.id;
    const finalHash = stateHash(host);

    const first = await call('POST', `/api/games/${game.id}/result`, {
      as: 'm', json: { winnerUserId, stateHash: finalHash }
    });
    assert(first.status === 200 && first.json.waiting === true, `the first report returned ${first.status} ${first.text}`);
    const second = await call('POST', `/api/games/${game.id}/result`, {
      as: 'n', json: { winnerUserId, stateHash: finalHash }
    });
    assert(second.status === 200 && second.json.agreed === true,
      `the two clients agreed and the server did not accept it: ${second.status} ${second.text}`);
    assert(second.json.game.desync === false, `a driven match that agreed was flagged as a desync: ${second.text}`);

    // The reconnect, which is the reason the move is in the row at all: a client with
    // nothing but the seed and the log has to rebuild the board both players are looking
    // at, driving and all.
    const rejoin = makeClient(seed);
    const read = await call('GET', `/api/games/${game.id}`, { as: 'm' });
    const log = read.json.shots;
    assert(log.length === turns, `the stored log has ${log.length} turns for ${turns} played`);

    let replayed = 0;
    let replayedDrives = 0;
    for (const shot of log) {
      assert(Number.isInteger(shot.move), `turn ${shot.turn} has no integer move to replay`);
      const hash = applyShot(rejoin, shot);
      assert(hash === shot.stateHash,
        `replaying turn ${shot.turn} (move ${shot.move}) produced a different board than the server ` +
        `stored:\n  replayed: ${hash}\n  stored:   ${shot.stateHash}`);
      if (shot.move !== 0) replayedDrives++;
      replayed++;
    }
    assert(replayed === turns, `replayed ${replayed} of ${turns} turns`);
    assert(replayedDrives > 0, 'the replay carried no driving at all');
    assert(stateHash(rejoin) === finalHash,
      `the replayed board is not the board the two players ended on:\n  replayed: ${stateHash(rejoin)}\n  played:   ${finalHash}`);

    state.notes.push(`driven match on seed ${seed}: ${turns} turns, ${replayedDrives} of them with driving, ` +
      `every one byte-identical on both clients and equal to the stored hash`);
    return `seed ${seed}: ${turns} turns, ${replayedDrives} with driving, every one identical on both clients and ` +
      `equal to the stored hash; the winner agreed by both reports; a third client rebuilt the final board from ` +
      `the seed and the ${replayed}-turn log, driving included (${finalHash.slice(0, 40)}…)`;
  });

  /**
   * The one thing that cannot be checked from scratch: a database that already holds shots
   * written before the move column existed.
   *
   * The deployed volume is exactly that, so the sequence is played out properly — a server
   * plays two turns, is stopped, the column is dropped behind its back to put the file
   * back the way the deployed one is, and a server is booted against it again. What has to
   * come back is a log that reads as having not moved rather than as NULL, because a NULL
   * there would replay as a different board and every stored match would be a desync.
   */
  await check('18. a database written before the move column still reads its shots as having not moved', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanks-evolved-migration-'));
    const dbFile = path.join(dataDir, 'tanks.db');
    const env = Object.assign({}, process.env, {
      PORT: '0',
      HOST: '127.0.0.1',
      TANKS_DB: dbFile,
      TANKS_SECURE_COOKIES: '0',
      TANKS_REGISTER_MAX: String(REGISTER_MAX),
      TANKS_SHOTS_MAX: String(SHOTS_MAX),
      TANKS_ABANDON_MS: String(ABANDON_MS),
      TANKS_SWEEP_MS: String(SWEEP_MS)
    });

    const outerBase = state.base;
    const outerPlayers = state.players;
    let server = startServer(env);
    let sqlite = null;
    try {
      state.base = await waitForListen(server);
      state.players = {};
      server.logs.length = 0;

      // Two turns played for real, so the rows are ones a real client would have written.
      await register('m');
      await register('n');
      const game = await pairUp('m', 'n');
      const client = makeClient(game.seed);
      const stored = [];
      for (const as of ['m', 'n']) {
        const tank = client.game.world.tanks[client.game.world.activeIndex];
        client.TE.tank.setAngle(tank, 42);
        client.TE.tank.setPower(tank, 66);
        const hash = stateHash(client);
        const res = await call('POST', `/api/games/${game.id}/shot`, {
          as, json: { angle: 42, power: 66, stateHash: hash }
        });
        assert(res.status === 201, `turn ${stored.length + 1} returned ${res.status} ${res.text}`);
        // Applied the way the browser applies a relayed turn, so the hashes mean something.
        assert(applyShot(client, res.json.shots[res.json.shots.length - 1]) === hash,
          'the client could not reproduce its own turn');
        stored.push(hash);
      }

      const stop = await stopServer(server);

      // Put the file back the way the deployed volume is: a shots table with no move
      // column. This is what the ALTER TABLE in db.js exists to catch up with.
      try {
        // node:sqlite is experimental on this runtime and says so once, on the way in. The
        // server under test loads the same module and announces it in its own log; what is
        // suppressed here is only that announcement landing in the middle of this suite's
        // output, where it would read as a regression rather than as a fact about Node.
        const emit = process.emitWarning;
        process.emitWarning = function (warning, ...rest) {
          if (typeof warning === 'string' && /experimental feature/i.test(warning)) return undefined;
          return emit.call(process, warning, ...rest);
        };
        try {
          sqlite = require('node:sqlite');
        } finally {
          process.emitWarning = emit;
        }
      } catch {
        throw new Error(`node:sqlite is not available on ${process.version}, so the deployed schema cannot be simulated`);
      }
      const raw = new sqlite.DatabaseSync(dbFile);
      const before = raw.prepare('PRAGMA table_info(shots)').all().map((row) => row.name);
      assert(before.includes('move'), `the shots table was created without a move column: ${before.join(', ')}`);
      raw.exec('ALTER TABLE shots DROP COLUMN move');
      const dropped = raw.prepare('PRAGMA table_info(shots)').all().map((row) => row.name);
      assert(!dropped.includes('move'), 'the column could not be dropped, so nothing was simulated');
      const rows = raw.prepare('SELECT turn, angle, power, state_hash FROM shots ORDER BY turn').all();
      assert(rows.length === 2, `expected 2 pre-migration shots, found ${rows.length}`);
      raw.close();

      // Boot a server against the file as it was left, which is what a deploy does.
      server = startServer(env);
      state.base = await waitForListen(server);
      server.logs.length = 0;

      const migrated = new sqlite.DatabaseSync(dbFile);
      const columns = migrated.prepare('PRAGMA table_info(shots)').all();
      const moveColumn = columns.find((column) => column.name === 'move');
      migrated.close();
      assert(moveColumn, 'the move column was never added back');
      assert(moveColumn.notnull === 1, 'the move column came back nullable');
      assert(Number(moveColumn.dflt_value) === 0, `the move column defaults to ${moveColumn.dflt_value}`);

      const read = await call('GET', `/api/games/${game.id}`, { as: 'm' });
      assert(read.status === 200, `the game written before the migration could not be read: ${read.status} ${read.text}`);
      assert(read.json.shots.length === 2, `the pre-migration log came back as ${read.text}`);
      for (const shot of read.json.shots) {
        assert(shot.move === 0,
          `turn ${shot.turn} reads as move ${JSON.stringify(shot.move)} — the deployed rows did not backfill to 0`);
        assert(Number.isInteger(shot.move), `turn ${shot.turn} has a move that is not a number: ${JSON.stringify(shot.move)}`);
        assert(shot.angle === 42 && shot.power === 66, `turn ${shot.turn} lost its aim: ${JSON.stringify(shot)}`);
      }
      assert(read.json.game.status === 'playing', `the pre-migration game is ${read.json.game.status}`);
      assert(read.json.turn === 3, `the pre-migration game claims turn ${read.json.turn}`);

      // And the migrated game can still be played on: a row inserted after the ALTER has to
      // satisfy the NOT NULL the column came back with.
      const next = await call('POST', `/api/games/${game.id}/shot`, {
        as: 'm', json: { move: 4, angle: 44, power: 71, stateHash: 'MIGRATED|turn3|' + 'z'.repeat(20) }
      });
      assert(next.status === 201, `a turn after the migration was refused: ${next.status} ${next.text}`);
      const played = next.json.shots[2];
      assert(played.move === 4, `the first turn written after the migration stored move ${played.move}`);
      assert(next.json.shots.map((s) => s.move).join(',') === '0,0,4',
        `the log after the migration is ${JSON.stringify(next.json.shots.map((s) => s.move))}`);

      // Replaying the stored turns still lands on the hashes they were stored with. That is
      // the whole reason the backfill has to be 0 rather than NULL: a NULL there replays as
      // a turn where the tank did not move, on a board where it did, and every match
      // written before this deploy would report itself as a desync.
      const replay = makeClient(game.seed);
      let replayedPre = 0;
      for (const shot of read.json.shots) {
        assert(shot.stateHash && shot.stateHash.length > 0, `turn ${shot.turn} has no hash`);
        assert(applyShot(replay, shot) === shot.stateHash,
          `replaying pre-migration turn ${shot.turn} did not land on the hash it was stored with`);
        replayedPre++;
      }
      assert(replayedPre === stored.length, `replayed ${replayedPre} of ${stored.length} pre-migration turns`);

      return `${replayedPre} turns written and replayed before the migration, the move column dropped and ` +
        're-added (NOT NULL, default 0) by the next boot, both old rows reading 0 rather than NULL and still ' +
        'carrying their aim, hash and replay, and turn 3 played on top of them (log moves 0,0,4)';
    } finally {
      state.base = outerBase;
      state.players = outerPlayers;
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
  for (const note of state.notes) console.log(`note  ${note}`);
  console.log('');
  console.log(`${results.length - failed}/${results.length} checks passed`);
  return failed;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanks-evolved-match-'));
  const env = Object.assign({}, process.env, {
    PORT: '0',
    HOST: '127.0.0.1',
    TANKS_DB: path.join(dataDir, 'tanks.db'),
    TANKS_SECURE_COOKIES: '0',
    TANKS_REGISTER_MAX: String(REGISTER_MAX),
    TANKS_LOGIN_MAX: String(LOGIN_MAX),
    TANKS_SHOTS_MAX: String(SHOTS_MAX),
    TANKS_CHAT_MAX: String(CHAT_MAX),
    TANKS_STREAM_KEEPALIVE_MS: String(STREAM_KEEPALIVE_MS),
    TANKS_ABANDON_MS: String(ABANDON_MS),
    TANKS_SWEEP_MS: String(SWEEP_MS)
  });

  console.log('Tanks Evolved — Phase 3 server acceptance (the networked match)');
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

    await runChecks(server);
    await runFullMatch();
    await runLimitChecks();
    await runWalkoverChecks();
    await runMovementChecks();
  } catch {
    // A failed start is already recorded; the suite's own checks come out as "not run".
  }

  stop = await stopServer(server);

  await check('14. SIGTERM shuts down cleanly with two streams still open', async () => {
    assert(!stop.timedOut, 'the server did not exit within 10s of SIGTERM');
    assert(stop.code === 0, `expected exit code 0, got ${stop.code} (signal ${stop.signal})`);
    const log = server.logs.join('');
    assert(/SIGTERM: shutting down/.test(log), `no shutdown log line:\n${log}`);
    assert(/shutdown complete/.test(log), 'the shutdown did not finish');
    return `SIGTERM with 2 streams open → exit code 0, database closed`;
  });

  await check('15. the log holds no password, token, cookie, email address or chat message', async () => {
    const log = server.logs.join('');
    assert(!/ERROR/.test(log), `the server logged an error:\n${log}`);
    assert(/turn 1: shot by user/.test(log), `no shot was logged:\n${log}`);
    assert(!log.includes(PASSWORD), 'the password appears in the server log');
    assert(!log.includes('good luck'), 'a chat message appears in the server log');
    for (const player of Object.values(state.players)) {
      if (!player) continue;
      assert(!log.includes(player.token), 'a session token appears in the server log');
      assert(!log.includes(player.email), 'an email address appears in the server log');
    }
    assert(!log.includes(COOKIE_NAME), 'a cookie value appears in the server log');
    return `${log.split('\n').filter(Boolean).length} log lines, none containing a password, token, cookie, address or message`;
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
