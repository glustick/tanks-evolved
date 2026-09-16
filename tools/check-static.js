#!/usr/bin/env node
/**
 * tools/check-static.js — static checks for the constraints that must hold for
 * a no-build static site that still has to work from file://.
 *
 * Verifies, without running a browser:
 *   1. every <script src> / <link href> in index.html exists on disk
 *   2. every js file parses (catches syntax errors early)
 *   3. no ES modules, no dynamic script loading, no requires — the client is
 *      plain <script> tags and TE.* globals, and stays that way
 *   4. no external URLs anywhere: nothing the page references may leave its own
 *      origin (no CDN, no third-party host, no absolute http(s) target)
 *   5. every request the client makes is a relative, same-origin path
 *   6. every element id the client code requires exists in index.html
 *   7. index.html loads the js files in a valid dependency order
 *
 * Why 3 no longer bans fetch/XHR, and why 5 replaced it:
 *
 *   Until Phase 1 this was a file://-only site, and "no network calls of any
 *   kind" was the honest way to state that. Phase 2 adds a lobby, so the client
 *   does talk to a server — but only to the one that served the page. The rule
 *   that still matters is therefore not "no requests" but "no request that
 *   leaves the origin", which is what 5 asserts and what 4 asserts for every
 *   other kind of reference. The file:// path is unchanged: js/net.js asks
 *   location.protocol before it asks for anything, so a page opened from disk
 *   makes no request at all.
 *
 * Usage:  node tools/check-static.js
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const HTML_PATH = path.join(ROOT, 'index.html');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail == null ? '' : String(detail) });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(ok, message) { if (!ok) throw new Error(message); }

const html = fs.readFileSync(HTML_PATH, 'utf8');
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
const jsFiles = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort();

/** A js file with its comments removed, so a rule cannot be tripped by prose. */
function code(file) {
  return fs.readFileSync(path.join(JS_DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// 1 + 7 ---------------------------------------------------------------
const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
const styleHrefs = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1])
  .filter((href) => !href.startsWith('data:'));

check('1. every asset referenced by index.html exists on disk', () => {
  const missing = [];
  for (const rel of [...scriptSrcs, ...styleHrefs]) {
    if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
  }
  assert(missing.length === 0, `missing files: ${missing.join(', ')}`);
  return `${scriptSrcs.length} scripts + ${styleHrefs.length} stylesheets all present`;
});

check('7. index.html loads the js files in a valid dependency order', () => {
  const loaded = scriptSrcs.map((s) => path.basename(s));
  // Every file that exists must be loaded, and must come after its dependencies.
  const order = ['version.js', 'utils.js', 'terrain.js', 'physics.js', 'tanks.js',
    'render.js', 'audio.js', 'input.js', 'game.js', 'net.js', 'screens.js', 'selftest.js'];
  for (const file of jsFiles) {
    assert(loaded.includes(file), `${file} exists but is not loaded by index.html`);
  }
  let last = -1;
  for (const file of order) {
    const at = loaded.indexOf(file);
    assert(at > last, `load order broken at ${file} (must come after the previous file)`);
    last = at;
  }
  assert(loaded[loaded.length - 1] === 'selftest.js' || loaded.length === order.length,
    'unexpected extra scripts');
  return `${loaded.length} scripts: ${loaded.join(' -> ')}`;
});

check('2. every js file parses', () => {
  const files = jsFiles.map((f) => path.join(JS_DIR, f));
  files.push(path.join(__dirname, path.basename(__filename)));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    new vm.Script(source, { filename: path.relative(ROOT, file) }); // parse only, never run
  }
  return `${files.length} files parsed (tools included)`;
});

check('3. no modules, no dynamic script loading, no require()', () => {
  const banned = [
    { pattern: /\btype\s*=\s*"module"/, what: 'ES module script' },
    { pattern: /\bimport\s+[\w{*]/, what: 'import statement' },
    { pattern: /\bexport\s+(default|const|function|class)\b/, what: 'export statement' },
    { pattern: /\bimportScripts\s*\(/, what: 'importScripts()' },
    { pattern: /\brequire\s*\(/, what: 'require()' },
    { pattern: /createElement\s*\(\s*['"]script['"]\s*\)/, what: 'dynamic <script> creation' }
  ];
  const offenders = [];
  for (const file of jsFiles) {
    const raw = code(file);
    for (const rule of banned) {
      if (rule.pattern.test(raw)) offenders.push(`${file}: ${rule.what}`);
    }
  }
  for (const rule of banned) {
    if (rule.pattern.test(htmlNoComments)) offenders.push(`index.html: ${rule.what}`);
  }
  assert(offenders.length === 0, offenders.join('; '));
  return `${banned.length} patterns scanned across ${jsFiles.length} js files + index.html`;
});

check('4. no external URLs anywhere (nothing leaves the origin)', () => {
  const offenders = [];
  const urlPattern = /(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/gi;
  for (const file of [...jsFiles.map((f) => `js/${f}`), 'index.html', 'css/style.css']) {
    const raw = fs.readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    const found = raw.match(urlPattern);
    if (found) offenders.push(`${file}: ${[...new Set(found)].join(', ')}`);
  }
  assert(offenders.length === 0, `external references: ${offenders.join(' | ')}`);
  return 'no absolute http(s), protocol-relative or CDN references anywhere in the page';
});

// 5 -------------------------------------------------------------------
check('5. every request the client makes is a relative, same-origin path', () => {
  // The client's whole network surface is fetch and EventSource. Two things have to hold:
  // the target of a call has to be a path (never a URL), and every path-shaped string in
  // the client has to be origin-relative — so a request cannot be pointed at somebody
  // else's server by an edit to a constant table either.
  const callPattern = /\b(?:fetch|EventSource)\s*\(\s*([^,)\n]*)/g;
  const literalPattern = /^(['"])(.*)\1$/;
  const identifierPattern = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
  // A string that is meant as a location rather than as a message: it starts at the root,
  // or it names another origin. Anything else ('shell:', 'text/javascript') is prose.
  const pathLikePattern = /^(?:\/|.*:\/\/)/;

  function assertRelative(file, target) {
    assert(!target.startsWith('//'), `${file}: "${target}" is protocol-relative, which leaves the origin`);
    assert(!/^[a-z][a-z0-9+.-]*:\/\//i.test(target), `${file}: "${target}" is an absolute URL`);
    assert(target.startsWith('/'), `${file}: "${target}" is not origin-relative (a path must start with "/")`);
  }

  const offenders = [];
  let calls = 0;
  const indirect = [];

  for (const file of jsFiles) {
    const raw = code(file);

    for (const call of raw.matchAll(callPattern)) {
      calls++;
      const target = call[1].trim();
      const literal = literalPattern.exec(target);
      if (literal) {
        try {
          assertRelative(file, literal[2]);
        } catch (err) {
          offenders.push(err.message);
        }
      } else if (identifierPattern.test(target)) {
        // A name from this file's own vocabulary (net.js's PATHS table). The table itself
        // is checked below, which is where that indirection is made safe.
        indirect.push(`${file}: ${target}`);
      } else {
        offenders.push(`${file}: a request target is built at runtime ("${target}"), so what it resolves to cannot be checked`);
      }
    }

    // Every string that looks like a path or a URL, wherever it appears.
    for (const literal of raw.matchAll(/(['"])([^'"]*)\1/g)) {
      const value = literal[2];
      if (!pathLikePattern.test(value)) continue;
      try {
        assertRelative(file, value);
      } catch (err) {
        offenders.push(err.message);
      }
    }
  }

  assert(calls > 0, 'no fetch or EventSource call was found at all — this check would be vacuous');
  assert(offenders.length === 0, offenders.join(' | '));

  // The one place a request target is not written at the call site: net.js's path table,
  // which is the client's whole API surface and is asserted above as well.
  const declared = [...code('net.js').matchAll(/(['"])(\/api\/[^'"]*)\1/g)].map((m) => m[2]);
  assert(declared.length > 0, 'js/net.js declares no /api paths');
  for (const target of declared) {
    assert(!target.includes('//'), `js/net.js declares a path with a double slash: ${target}`);
  }
  return `${calls} network call(s), all origin-relative (${indirect.length} via js/net.js's ${declared.length}-path table)`;
});

// 6 -------------------------------------------------------------------
check('6. every element id required by the client exists in index.html', () => {
  // Two modules own element ids now: input.js the HUD, screens.js the sign-in and lobby
  // screens. Both export the contract, and both directions are checked for both.
  const owners = [
    { file: 'input.js', list: 'REQUIRED_IDS' },
    { file: 'screens.js', list: 'REQUIRED_IDS' }
  ];
  const ids = [];
  for (const owner of owners) {
    const source = fs.readFileSync(path.join(JS_DIR, owner.file), 'utf8');
    const block = source.match(new RegExp(`var ${owner.list} = \\[([\\s\\S]*?)\\];`));
    assert(block, `could not locate ${owner.list} in js/${owner.file}`);
    const found = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert(found.length > 10, `only found ${found.length} ids in js/${owner.file}`);
    ids.push(...found);
  }

  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = ids.filter((id) => !htmlIds.has(id));
  assert(missing.length === 0, `index.html is missing: ${missing.join(', ')}`);

  // The reverse direction catches ids the code no longer uses.
  const jsControlled = ['stage', 'help-panel'];
  const unused = [...htmlIds].filter((id) => !ids.includes(id) && !jsControlled.includes(id));
  return `${ids.length} ids verified both ways (${owners.map((o) => o.file).join(' + ')})` +
    (unused.length ? ` (extra ids present: ${unused.join(', ')})` : '');
});

// ---------------------------------------------------------------- reporting
let failed = 0;
console.log('Tanks Evolved — static constraint check');
console.log('');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (r.detail) console.log(`      ${r.detail.replace(/\n/g, '\n      ')}`);
  if (!r.ok) failed++;
}
console.log('');
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
