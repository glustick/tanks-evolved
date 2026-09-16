/**
 * version.js — release identity for the build.
 *
 * Kept as its own tiny file so the HUD, the self-test and any future
 * deployment script can read one authoritative version string.
 * Plain globals (no modules) so the file also loads inside a `vm` context
 * in tools/check-determinism.js and tools/check-static.js.
 */
(function (root) {
  'use strict';

  var RELEASE_VERSION = '0.1.0';
  var BUILD_NUMBER = 1;

  root.RELEASE_VERSION = RELEASE_VERSION;
  root.BUILD_NUMBER = BUILD_NUMBER;

  var TE = (root.TE = root.TE || {});
  TE.version = {
    RELEASE_VERSION: RELEASE_VERSION,
    BUILD_NUMBER: BUILD_NUMBER,
    /** "0.1.0+b1" — the string shown in the UI. */
    label: RELEASE_VERSION + '+b' + BUILD_NUMBER
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
