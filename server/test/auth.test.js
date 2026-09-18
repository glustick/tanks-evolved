#!/usr/bin/env node
/**
 * server/test/auth.test.js — Phase 1 acceptance: accounts, sessions and storage over
 * real HTTP.
 *
 * The server under test is the real one, spawned as a child process on an ephemeral port
 * against a database in a temporary directory — not an in-process fixture. So what passes
 * here is server/index.js as the container runs it: environment parsing, the schema
 * applied on boot, the cookie flags, and the shutdown path at the end.
 *
 * Every request goes over the network with fetch, and cookies are carried by hand rather
 * than by a jar: Set-Cookie is one of the things under test, so it stays visible.
 *
 * Usage:  node server/test/auth.test.js
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'index.js');
const REPO_ROOT = path.join(__dirname, '..', '..');

// Long enough to satisfy the length rule, and distinctive enough that finding either
// string in a database file or in a response is never a coincidence.
const EMAIL = 'gunner@example.com';
const PASSWORD = 'correct-horse-battery-4821';

// A low login limit, set through the environment rather than assumed: every request here
// comes from one address (which is exactly why the limiter is reachable at all) and every
// login attempt costs a deliberate scrypt hash, so the default of 10 would make this file
// slower than it needs to be for no extra coverage.
const LOGIN_MAX = 4;
const REGISTER_MAX = 20;

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

// ----------------------------------------------------------------- processes
/** Start the server as a child process, capturing its output for the log checks. */
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
let base = null;

/** One request. `json` sends an object, `raw` sends a string with an explicit type. */
async function call(method, target, options = {}) {
  if (target.startsWith('/api/auth/login')) state.loginAttempts++;
  const headers = Object.assign({}, options.headers);
  if (options.cookie !== undefined) headers.Cookie = `te_session=${options.cookie}`;

  let body;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.raw !== undefined) {
    headers['Content-Type'] = options.contentType || 'application/json';
    body = options.raw;
  }

  const res = await fetch(base + target, { method, headers, body });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not every response is JSON (the static client is not).
  }
  // getSetCookie keeps multiple Set-Cookie headers separate; the fallback is for a
  // runtime where only the combined header is available.
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);

  return { status: res.status, headers: res.headers, text, json, setCookies };
}

function sessionCookieOf(response) {
  return response.setCookies.find((cookie) => cookie.startsWith('te_session=')) || null;
}

function tokenOf(response) {
  const cookie = sessionCookieOf(response);
  return cookie === null ? null : cookie.slice('te_session='.length).split(';')[0];
}

// ---------------------------------------------------------------------- suite
/** State that later checks depend on (the account, its live token, the 401 message). */
const state = { user: null, token: null, tokens: [], invalidCredentialsMessage: null, loginAttempts: 0 };

async function runChecks(dataDir) {
  await check('1. register creates the account, starts a session, and returns no secret', async () => {
    // Sent with capitals and surrounding space on purpose: the stored form has to be the
    // normalised one, or the UNIQUE index would let both spellings exist as two accounts.
    const res = await call('POST', '/api/auth/register', { json: { email: `  ${EMAIL.toUpperCase()} `, password: PASSWORD } });
    assert(res.status === 201, `expected 201, got ${res.status} ${res.text}`);

    const cookie = sessionCookieOf(res);
    assert(cookie !== null, 'no te_session cookie was set');
    for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=']) {
      assert(cookie.includes(attribute), `the session cookie is missing ${attribute}: ${cookie}`);
    }
    assert(!cookie.includes('Secure'), 'Secure was set on a plain-http test server');

    assert(res.json && res.json.user, `the response has no user: ${res.text}`);
    assert(res.json.user.email === EMAIL, `email was not normalised: ${res.json.user.email}`);
    assert(Number.isInteger(res.json.user.id), `user id is not an integer: ${res.text}`);
    assert(Object.keys(res.json.user).sort().join(',') === 'createdAt,email,id',
      `user object has unexpected fields: ${JSON.stringify(res.json.user)}`);

    // A hash, a salt or a KDF parameter in a response body is the leak this check exists
    // to catch — it is what would happen if toPublicUser ever stopped being used.
    assert(!/password|scrypt|\bkdf\b|salt|hash/i.test(res.text), `the response mentions credential material: ${res.text}`);

    state.user = res.json.user;
    state.token = tokenOf(res);
    state.tokens.push(state.token);
    return `201, id ${state.user.id}, email normalised to ${state.user.email}, cookie HttpOnly + SameSite=Lax`;
  });

  await check('2. GET /api/me with the session cookie returns the same user', async () => {
    const res = await call('GET', '/api/me', { cookie: state.token });
    assert(res.status === 200, `expected 200, got ${res.status} ${res.text}`);
    assert(res.json.user.id === state.user.id && res.json.user.email === state.user.email,
      `a different user came back: ${res.text}`);
    return `200, ${res.json.user.email} (id ${res.json.user.id})`;
  });

  await check('3. GET /api/me with no cookie is 401', async () => {
    const res = await call('GET', '/api/me');
    assert(res.status === 401, `expected 401, got ${res.status} ${res.text}`);
    assert(res.json && res.json.error === 'unauthenticated', `unexpected body: ${res.text}`);
    assert(!res.text.includes(EMAIL), 'the 401 body leaked an account');
    return `401, ${res.json.message}`;
  });

  await check('4. logout ends the session (the old cookie no longer works)', async () => {
    const res = await call('POST', '/api/auth/logout', { cookie: state.token });
    assert(res.status === 200, `expected 200, got ${res.status} ${res.text}`);

    const cleared = sessionCookieOf(res);
    assert(cleared !== null, 'logout did not send a clearing cookie');
    assert(/Max-Age=0/.test(cleared), `logout did not expire the cookie: ${cleared}`);

    // Replaying the *same token* is the part that matters: it proves the row is gone
    // server-side, not merely that the browser was told to forget it.
    const after = await call('GET', '/api/me', { cookie: state.token });
    assert(after.status === 401, `the logged-out session still authenticates (got ${after.status})`);
    return '200 + Max-Age=0, then 401 with the same token';
  });

  await check('5. login with the same credentials works and yields a usable session', async () => {
    const res = await call('POST', '/api/auth/login', { json: { email: EMAIL, password: PASSWORD } });
    assert(res.status === 200, `expected 200, got ${res.status} ${res.text}`);
    assert(res.json.user.id === state.user.id, `logged in as the wrong user: ${res.text}`);

    const token = tokenOf(res);
    assert(token !== null && token !== state.tokens[0], 'login did not issue a fresh session token');
    state.token = token;
    state.tokens.push(token);

    const me = await call('GET', '/api/me', { cookie: token });
    assert(me.status === 200 && me.json.user.id === state.user.id, `the new session does not work: ${me.status} ${me.text}`);
    return `200, new session token resolves to ${me.json.user.email}`;
  });

  await check('6. registering the same email again is 409', async () => {
    const res = await call('POST', '/api/auth/register', { json: { email: EMAIL, password: PASSWORD } });
    assert(res.status === 409, `expected 409, got ${res.status} ${res.text}`);
    assert(res.json.error === 'email_taken', `unexpected error code: ${res.text}`);
    assert(sessionCookieOf(res) === null, 'a refused registration still handed out a session');
    return `409, no session issued`;
  });

  await check('7. a wrong password is 401 without revealing the account', async () => {
    const res = await call('POST', '/api/auth/login', { json: { email: EMAIL, password: 'definitely-the-wrong-one' } });
    assert(res.status === 401, `expected 401, got ${res.status} ${res.text}`);
    assert(sessionCookieOf(res) === null, 'a failed login handed out a session');
    state.invalidCredentialsMessage = res.json.message;
    return `401, "${res.json.message}"`;
  });

  await check('8. an unknown email is 401 with the identical message', async () => {
    const res = await call('POST', '/api/auth/login', { json: { email: 'nobody@example.com', password: 'definitely-the-wrong-one' } });
    assert(res.status === 401, `expected 401, got ${res.status} ${res.text}`);
    assert(res.json.error === 'invalid_credentials', `unexpected error code: ${res.text}`);
    assert(res.json.message === state.invalidCredentialsMessage,
      `the message differs from the wrong-password case, which enumerates accounts: "${res.json.message}" vs "${state.invalidCredentialsMessage}"`);
    return `401, same body and message as check 7 ("${res.json.message}")`;
  });

  await check('9. a password shorter than 8 characters is 400', async () => {
    const res = await call('POST', '/api/auth/register', { json: { email: 'shorty@example.com', password: 'seven77' } });
    assert(res.status === 400, `expected 400, got ${res.status} ${res.text}`);
    assert(res.json.error === 'invalid_password', `unexpected error code: ${res.text}`);
    assert(!res.text.includes('seven77'), 'the rejected password was echoed back');
    return `400, "${res.json.message}"`;
  });

  await check('10. malformed email addresses are 400', async () => {
    const malformed = ['not-an-email', 'a@b', 'two@@example.com', 'spaces in@example.com', '@example.com'];
    for (const email of malformed) {
      const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD } });
      assert(res.status === 400, `${JSON.stringify(email)} was accepted (${res.status} ${res.text})`);
      assert(res.json.error === 'invalid_email', `${JSON.stringify(email)} failed with ${res.text}`);
    }
    return `${malformed.length} malformed addresses rejected with 400 invalid_email`;
  });

  await check('11. repeated failed logins are rate limited', async () => {
    let rejected = null;
    let attempted = 0;
    for (; attempted < LOGIN_MAX + 3; attempted++) {
      const res = await call('POST', '/api/auth/login', { json: { email: EMAIL, password: 'still-not-the-password' } });
      if (res.status === 429) {
        rejected = res;
        break;
      }
      assert(res.status === 401, `expected 401 or 429, got ${res.status} ${res.text}`);
    }
    assert(rejected !== null, `no 429 in ${attempted} further failed logins (the limit is ${LOGIN_MAX})`);

    const retryAfter = rejected.headers.get('retry-after');
    assert(retryAfter !== null, 'the 429 has no Retry-After header');
    assert(Number(retryAfter) > 0, `Retry-After is not a positive number of seconds: ${retryAfter}`);
    assert(rejected.json.error === 'rate_limited', `unexpected error code: ${rejected.text}`);

    // The window has to open at the limit, not before and not later: this counter spans
    // every login in the suite (successful ones included, since an attempt is an attempt),
    // so the 429 must arrive on exactly the attempt after the last permitted one.
    assert(state.loginAttempts === LOGIN_MAX + 1,
      `the 429 arrived on login ${state.loginAttempts}, expected ${LOGIN_MAX + 1}`);
    return `429 on login ${state.loginAttempts} of this window (limit ${LOGIN_MAX}), Retry-After: ${retryAfter}s`;
  });

  await check('12. GET /api/health is 200 with ok:true and the client\'s version', async () => {
    const res = await call('GET', '/api/health');
    assert(res.status === 200, `expected 200, got ${res.status} ${res.text}`);
    assert(res.json && res.json.ok === true, `no ok:true in ${res.text}`);

    // Re-derived independently, with a regex rather than the vm the server uses, so a
    // broken server-side read cannot agree with itself and pass.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'js', 'version.js'), 'utf8');
    const declared = /RELEASE_VERSION\s*=\s*'([^']+)'/.exec(source);
    assert(declared !== null, 'could not read RELEASE_VERSION from js/version.js');
    assert(res.json.version === declared[1], `health reports ${res.json.version}, js/version.js declares ${declared[1]}`);
    return `200, {"ok":true,"version":"${res.json.version}"}`;
  });

  await check('13. the static client is served at /', async () => {
    const res = await call('GET', '/');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.text.includes('id="stage"'), 'the page served at / has no #stage canvas');
    assert(/^text\/html/.test(res.headers.get('content-type') || ''), `served as ${res.headers.get('content-type')}`);
    assert(res.headers.get('cache-control') === 'no-cache', `index.html is not revalidated: ${res.headers.get('cache-control')}`);
    return `200 text/html, ${res.text.length} bytes, contains id="stage"`;
  });

  await check('14. the database holds no plaintext password (nor a session token)', async () => {
    const files = fs.readdirSync(dataDir);
    assert(files.length > 0, 'the database directory is empty');
    // Every file, not just the .db: with WAL the newest rows live in the -wal file until
    // a checkpoint, so searching one file would miss exactly the rows just written.
    const blob = Buffer.concat(files.map((name) => fs.readFileSync(path.join(dataDir, name))));

    // A negative result means nothing without a positive control: the account has to be
    // in this data, or the check would also pass on a database that was never written.
    assert(blob.includes(EMAIL), `no trace of the account in ${files.join(', ')} — this check would be vacuous`);
    assert(!blob.includes(PASSWORD), 'the plaintext password is in the database file');
    assert(!blob.includes(state.token), 'the raw session token is in the database file');
    return `${files.join(', ')} (${blob.length} bytes): account present, password and token absent`;
  });

  await check('15. the API answers in JSON for unknown paths and wrong methods', async () => {
    const missing = await call('GET', '/api/does-not-exist');
    assert(missing.status === 404, `expected 404, got ${missing.status} ${missing.text}`);
    assert(missing.json && missing.json.error === 'not_found', `unexpected body: ${missing.text}`);
    assert(/^application\/json/.test(missing.headers.get('content-type') || ''), `not JSON: ${missing.headers.get('content-type')}`);

    const bare = await call('GET', '/api');
    assert(bare.status === 404, `GET /api returned ${bare.status}, expected 404`);

    const wrongMethod = await call('POST', '/api/health', { json: {} });
    assert(wrongMethod.status === 405, `expected 405, got ${wrongMethod.status} ${wrongMethod.text}`);
    assert(/\bGET\b/.test(wrongMethod.headers.get('allow') || ''), `405 without a usable Allow header: ${wrongMethod.headers.get('allow')}`);
    return '404 for an unknown path, 405 + Allow for the wrong method, all application/json';
  });

  await check('16. the static client keeps its MIME, cache, fallback and 304 rules', async () => {
    const css = await call('GET', '/css/style.css');
    assert(css.status === 200 && /^text\/css/.test(css.headers.get('content-type') || ''),
      `/css/style.css served as ${css.headers.get('content-type')}`);

    const js = await call('GET', '/js/version.js');
    assert(js.status === 200 && /javascript/.test(js.headers.get('content-type') || ''),
      `/js/version.js served as ${js.headers.get('content-type')}`);
    assert(/max-age=3600/.test(js.headers.get('cache-control') || ''), `js is not cacheable: ${js.headers.get('cache-control')}`);

    const missing = await call('GET', '/no/such/path');
    assert(missing.status === 200 && missing.text.includes('id="stage"'),
      `an unknown path did not fall back to the game shell (${missing.status})`);

    const lastModified = css.headers.get('last-modified');
    assert(lastModified !== null, 'no Last-Modified header, so no-cache means re-download every time');
    const revalidated = await call('GET', '/css/style.css', { headers: { 'If-Modified-Since': lastModified } });
    assert(revalidated.status === 304, `revalidation returned ${revalidated.status}, expected 304`);

    // The repository root is not a document root: server/ holds the database and this
    // harness, tools/ holds the rest, and neither may be fetchable over HTTP.
    for (const probe of ['/server/data/tanks.db', '/server/index.js', '/tools/check-static.js']) {
      const res = await call('GET', probe);
      assert(!res.text.includes('SQLite format') && !res.text.includes('use strict'),
        `${probe} was served over HTTP (${res.status})`);
      assert(res.text.includes('id="stage"'), `${probe} did not fall back to the game shell (${res.status})`);
    }
    return 'css/js MIME + 1h cache, index.html no-cache with 304, unknown paths and /server, /tools all fall back to the shell';
  });

  await check('17. hostile bodies are refused, with no internals in the reply', async () => {
    // Against register rather than login: the rate limiter runs before the body is read
    // (an attempt is an attempt, however malformed), and check 11 has just spent the
    // login window on purpose. Both endpoints share the same body reader.
    const wrongType = await call('POST', '/api/auth/register', { raw: 'email=a&password=b', contentType: 'text/plain' });
    assert(wrongType.status === 415, `a non-JSON content type returned ${wrongType.status}`);
    assert(wrongType.json && wrongType.json.error === 'unsupported_media_type', `unexpected body: ${wrongType.text}`);

    const badJson = await call('POST', '/api/auth/register', { raw: '{"email":', contentType: 'application/json' });
    assert(badJson.status === 400, `unparseable JSON returned ${badJson.status} ${badJson.text}`);

    const notAnObject = await call('POST', '/api/auth/register', { raw: '"just-a-string"', contentType: 'application/json' });
    assert(notAnObject.status === 400, `a non-object body returned ${notAnObject.status}`);

    // Just over the 8 KiB cap, and sent with a declared length: the server refuses it
    // before reading a byte.
    const declaredTooLong = await call('POST', '/api/auth/register',
      { raw: JSON.stringify({ email: EMAIL, password: 'x'.repeat(9000) }), contentType: 'application/json' });
    assert(declaredTooLong.status === 413, `an oversized body returned ${declaredTooLong.status} ${declaredTooLong.text.slice(0, 80)}`);

    // And again with no declared length at all, chunked, so the counter in the reader is
    // what has to stop it rather than the Content-Length header.
    const streamed = new ReadableStream({
      start(controller) {
        const chunk = new Uint8Array(1024).fill(0x78); // 'x'
        for (let i = 0; i < 12; i++) controller.enqueue(chunk);
        controller.close();
      }
    });
    const chunked = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: streamed,
      duplex: 'half'
    });
    assert(chunked.status === 413, `a chunked oversized body returned ${chunked.status}`);

    for (const res of [wrongType, badJson, notAnObject, declaredTooLong]) {
      assert(!/\n\s+at .*:\d+/.test(res.text), `a response contains a stack trace: ${res.text.slice(0, 120)}`);
      assert(!/server\/lib|node:internal|sqlite/i.test(res.text), `a response leaked internals: ${res.text.slice(0, 120)}`);
    }
    return '415 for a non-JSON type, 400 for unparseable or non-object JSON, 413 for oversized bodies (declared and chunked)';
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanks-evolved-auth-'));
  const env = Object.assign({}, process.env, {
    PORT: '0',
    HOST: '127.0.0.1',
    TANKS_DB: path.join(dataDir, 'tanks.db'),
    TANKS_SECURE_COOKIES: '0',
    TANKS_LOGIN_MAX: String(LOGIN_MAX),
    TANKS_REGISTER_MAX: String(REGISTER_MAX)
  });

  console.log('Tanks Evolved — Phase 1 server acceptance (accounts, sessions, storage)');
  console.log(`node ${process.version} · ${path.relative(REPO_ROOT, SERVER)} · database in ${dataDir}`);
  console.log('');

  const server = startServer(env);
  let stop = { code: null, signal: null, timedOut: true };

  try {
    try {
      base = await waitForListen(server);
    } catch (err) {
      results.push({ name: '0. the server starts and reports where it is listening', ok: false, detail: err.message });
      throw err;
    }
    results.push({
      name: '0. the server starts on an ephemeral port against a fresh database',
      ok: true,
      detail: `listening on ${base}`
    });

    await runChecks(dataDir);
  } catch {
    // A failed start is already recorded; the suite's own checks come out as "not run".
  }

  stop = await stopServer(server);

  await check('18. SIGTERM shuts the server down cleanly and closes the database', async () => {
    assert(!stop.timedOut, 'the server did not exit within 10s of SIGTERM');
    assert(stop.code === 0, `expected exit code 0, got ${stop.code} (signal ${stop.signal})`);
    const log = server.logs.join('');
    assert(/SIGTERM: shutting down/.test(log), `no shutdown log line:\n${log}`);
    assert(/shutdown complete/.test(log), 'the shutdown did not finish');
    return `SIGTERM → exit code 0, database closed`;
  });

  await check('19. the log holds no password, token or cookie value', async () => {
    const log = server.logs.join('');
    assert(log.length > 0, 'the server logged nothing at all');
    assert(/POST \/api\/auth\/login 200/.test(log), `no access lines in the log:\n${log}`);
    assert(!log.includes(PASSWORD), 'the password appears in the server log');
    for (const token of state.tokens) {
      assert(!log.includes(token), 'a session token appears in the server log');
    }
    assert(!log.includes('te_session'), 'a cookie value appears in the server log');
    assert(!/ERROR/.test(log), `the server logged an error:\n${log}`);
    return `${log.split('\n').filter(Boolean).length} log lines, none containing a password, token or cookie`;
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
