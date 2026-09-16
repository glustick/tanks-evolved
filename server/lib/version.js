/**
 * version.js — read RELEASE_VERSION out of the client's js/version.js.
 *
 * The static site already owns the version number, and CI reads that same file when it
 * tags an image. The server reads it too rather than carrying a second copy that can
 * drift: /api/health reporting a version nobody ships would be worse than no version at
 * all.
 *
 * It is evaluated in a `vm` context — the trick tools/check-determinism.js already uses
 * — because js/version.js is a plain script assigning globals, not a module. Parsing it
 * with a regex would be a guess about its syntax that breaks on the next edit.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * @param {string} repoRoot the repository root, which contains js/
 * @returns {string} e.g. "0.1.0"
 * @throws when the file is missing or does not define the version
 */
function readReleaseVersion(repoRoot) {
  const file = path.join(repoRoot, 'js', 'version.js');
  const sandbox = { console };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'js/version.js' });

  const version = sandbox.RELEASE_VERSION;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('js/version.js does not define RELEASE_VERSION');
  }
  return version;
}

module.exports = { readReleaseVersion };
