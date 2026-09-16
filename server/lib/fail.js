/**
 * fail.js — give up loudly, in one line.
 *
 * For the handful of problems where the process cannot do its job at all (no usable
 * node:sqlite, a database directory that cannot be created) a stack trace is noise:
 * everything below it is a Node internal the operator cannot act on. One line naming
 * the actual problem is what makes the container log useful.
 */
'use strict';

/**
 * Write a single diagnostic line to stderr and exit non-zero. Does not return.
 * @param {string} message what went wrong, phrased so the reader knows what to fix
 */
function fail(message) {
  process.stderr.write(`tanks-evolved server: ${message}\n`);
  process.exit(1);
}

module.exports = { fail };
