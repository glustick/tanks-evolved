/**
 * app.js — the request entry point and the object the process owns.
 *
 * Everything here is wiring, in the order a request passes through it: parse the URL,
 * decide API or static, hand off, log. The decision that matters is that these two
 * halves share one origin and one server, so a browser never has to be told about CORS
 * and the session cookie is a same-origin cookie — which is what makes SameSite=Lax
 * sufficient as the CSRF control.
 */
'use strict';

const http = require('node:http');
const { createApi, isApiPath } = require('./api');
const { createLobby } = require('./lobby');
const { createLimiters } = require('./ratelimit');
const { readReleaseVersion } = require('./version');
const { sendJson, clientIp } = require('./http');
const { fail } = require('./fail');
const logger = require('./logger');
const staticFiles = require('./static');
const storage = require('./db');

/** Access-log paths are truncated at this length: a log line is not a place for a 16 KB URL. */
const LOGGED_PATH_MAX = 2048;

/**
 * Build the server. Nothing is listening yet — index.js decides when, so the ordering of
 * "database open before listen" lives in the file that also owns shutdown.
 *
 * @param {{config: object, database: object}} deps
 * @returns {{server: import('node:http').Server, version: string, config: object,
 *   close: () => Promise<void>}}
 */
function createApp({ config, database }) {
  let version;
  try {
    version = readReleaseVersion(config.repoRoot);
  } catch (err) {
    // Without a version there is no healthcheck answer, and a healthcheck that lies is
    // worse than one that never starts.
    fail(`cannot read RELEASE_VERSION from js/version.js: ${err.message}`);
  }

  const lobby = createLobby({ config, database });
  const api = createApi({ config, database, version, limiters: createLimiters(config.rateLimit), lobby });

  function onRequest(req, res) {
    const startedAt = process.hrtime.bigint();

    // The access line. Logged from the response's own event, so the status and duration
    // are what actually went out rather than what a handler intended to send.
    const rawPath = req.url || '/';
    const queryAt = rawPath.indexOf('?');
    const loggedPath = (queryAt === -1 ? rawPath : rawPath.slice(0, queryAt)).slice(0, LOGGED_PATH_MAX);
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.request(req.method, loggedPath, res.statusCode, durationMs, clientIp(req));
    });

    let pathname;
    try {
      // Only the pathname is ever used: the base here is a placeholder, and nothing
      // builds a URL, a redirect or a file path out of the request's own host.
      pathname = new URL(rawPath, 'http://localhost').pathname;
    } catch {
      sendJson(res, 400, { error: 'bad_request', message: 'malformed request URL' });
      return;
    }

    if (isApiPath(pathname)) {
      api.handle(req, res, { pathname }).catch((err) => {
        // handle() already turns every failure into a response; this is the guarantee
        // that even a bug in that path cannot surface as an unhandled rejection. It
        // never returns a stack to the client.
        logger.error('the API dispatcher rejected', err);
        if (res.headersSent) res.destroy();
        else sendJson(res, 500, { error: 'internal_error', message: 'something went wrong' });
      });
      return;
    }

    staticFiles.serve(req, res, config, pathname).catch((err) => {
      logger.error('the static handler rejected', err);
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('internal error\n');
      }
    });
  }

  const server = http.createServer(onRequest);

  // Node's defaults (60s for headers, 300s for a whole request) are sized for uploads.
  // The largest thing a client sends here is a password, so a connection that cannot
  // finish in thirty seconds is either broken or holding a slot on purpose.
  server.requestTimeout = config.transportTimeoutMs;
  server.headersTimeout = Math.min(config.transportTimeoutMs, 10 * 1000);

  /**
   * Stop listening and wait for in-flight requests, then close the database. The order
   * is the point: nothing that arrives after the database is closed can find it shut.
   */
  async function close() {
    // The event streams first, and before the server stops accepting: server.close()
    // waits for in-flight requests, and a stream is one that would never finish on its
    // own — so a redeploy would otherwise sit out its whole grace period waiting for
    // connections this process can simply close.
    lobby.close();

    await new Promise((resolve) => {
      server.close(resolve);
      // Idle keep-alive sockets would otherwise hold this open for as long as a browser
      // chooses to keep them. Anything mid-request is left alone here; index.js cuts
      // those off if they outstay the shutdown grace period.
      server.closeIdleConnections();
    });
    storage.closeDatabase(database);
  }

  return { server, version, config, lobby, close };
}

module.exports = { createApp, LOGGED_PATH_MAX };
