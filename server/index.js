#!/usr/bin/env node
/**
 * index.js — the process: read the environment, open the database, listen, and shut down
 * cleanly.
 *
 * Everything with a decision in it lives in lib/. This file is the wiring, deliberately
 * kept to the order those things have to happen in: fail before listening (a server with
 * no storage has nothing to say), and stop listening before closing the database (so a
 * request cannot arrive to find it gone).
 *
 * Usage:  node server/index.js
 */
'use strict';

const { loadConfig } = require('./lib/config');
const storage = require('./lib/db');
const { createApp } = require('./lib/app');
const { fail } = require('./lib/fail');
const logger = require('./lib/logger');

// How long a shutdown waits for in-flight requests before cutting their sockets. Long
// enough for a login that is already half-way through scrypt, short enough that a
// redeploy is not held up by one stuck client.
const SHUTDOWN_GRACE_MS = 5000;

function main() {
  const config = loadConfig();
  for (const warning of config.warnings) logger.warn(warning);

  // Both of these can exit the process with one line of explanation (see lib/fail.js).
  const database = storage.openDatabase(config.dbFile);
  const app = createApp({ config, database });

  const pruned = storage.deleteExpiredSessions(database, Date.now());
  if (pruned > 0) logger.info(`pruned ${pruned} expired session${pruned === 1 ? '' : 's'}`);

  let shuttingDown = false;

  /**
   * Stop accepting, let in-flight requests finish, close the database, exit.
   * @param {string} reason what triggered this, for the log line
   * @param {number} exitCode 0 for a signal, non-zero when a crash brought us here
   */
  function shutdown(reason, exitCode = 0) {
    if (shuttingDown) {
      // A second signal means "now", not "again".
      logger.warn(`${reason} while already shutting down — exiting immediately`);
      process.exit(exitCode === 0 ? 1 : exitCode);
    }
    shuttingDown = true;
    process.exitCode = exitCode;
    logger.info(`${reason}: shutting down`);

    app.close().then(() => {
      logger.info('shutdown complete');
      process.exit(exitCode);
    });

    // Anything still mid-request gets the grace period, then its socket is cut: a
    // deployment must not be able to hang on one client that stopped reading.
    const force = setTimeout(() => {
      logger.warn(`still busy after ${SHUTDOWN_GRACE_MS}ms — closing remaining connections`);
      app.server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS);
    // Unreferenced on purpose: if the close completes first, this timer must not be what
    // keeps the process alive.
    force.unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A crash must be loud, not silent, and must still release the port and the database
  // handle. Both of these go down the same path as a signal but exit non-zero, so a
  // supervisor sees a failure rather than a clean stop.
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', err);
    shutdown('uncaught exception', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', reason);
    shutdown('unhandled promise rejection', 1);
  });

  app.server.on('error', (err) => {
    fail(`cannot listen on ${config.host}:${config.port}: ${err.code || err.message}`);
  });

  app.server.listen(config.port, config.host, () => {
    // The address, not the configured port: PORT=0 means "any free one" and the resolved
    // port is the only way to find out which. The test suite reads it from this line.
    const { port } = app.server.address();
    logger.info(`tanks-evolved server ${app.version} listening on http://${config.host}:${port}`);
    logger.info(`database ${config.dbFile}`);
  });
}

main();
