#!/usr/bin/env node
/**
 * tools/check-static.js — static checks for the constraints that must hold for
 * a no-build static site that has to work from file://.
 *
 * Verifies, without running a browser:
 *   1. every <script src> / <link href> in index.html exists on disk
 *   2. every js file parses (catches syntax errors early)
 *   3. no ES modules, no fetch/XHR, no dynamic script loading
 *   4. no external URLs (no CDN, no network calls of any kind)
 *   5. every element id required by js/input.js exists in index.html
 *   6. index.html loads the js files in a valid dependency order
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

// 1 + 6 ---------------------------------------------------------------
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

check('6. index.html loads the js files in a valid dependency order', () => {
  const loaded = scriptSrcs.map((s) => path.basename(s));
  // Every file that exists must be loaded, and must come after its dependencies.
  const order = ['version.js', 'utils.js', 'terrain.js', 'physics.js', 'tanks.js',
    'render.js', 'audio.js', 'input.js', 'game.js', 'selftest.js'];
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
    const code = fs.readFileSync(file, 'utf8');
    new vm.Script(code, { filename: path.relative(ROOT, file) }); // parse only, never run
  }
  return `${files.length} files parsed (tools included)`;
});

check('3. no modules, no fetch/XHR, no dynamic script loading', () => {
  const banned = [
    { pattern: /\btype\s*=\s*"module"/, what: 'ES module script' },
    { pattern: /\bimport\s+[\w{*]/, what: 'import statement' },
    { pattern: /\bexport\s+(default|const|function|class)\b/, what: 'export statement' },
    { pattern: /\bfetch\s*\(/, what: 'fetch()' },
    { pattern: /\bXMLHttpRequest\b/, what: 'XMLHttpRequest' },
    { pattern: /\bimportScripts\s*\(/, what: 'importScripts()' },
    { pattern: /\brequire\s*\(/, what: 'require()' },
    { pattern: /createElement\s*\(\s*['"]script['"]\s*\)/, what: 'dynamic <script> creation' }
  ];
  const offenders = [];
  for (const file of jsFiles) {
    const raw = fs.readFileSync(path.join(JS_DIR, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
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

check('4. no external URLs anywhere (works fully offline / file://)', () => {
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
  return 'no http(s), protocol-relative or CDN references';
});

check('5. every element id required by js/input.js exists in index.html', () => {
  const inputSrc = fs.readFileSync(path.join(JS_DIR, 'input.js'), 'utf8');
  const block = inputSrc.match(/var REQUIRED_IDS = \[([\s\S]*?)\];/);
  assert(block, 'could not locate REQUIRED_IDS in js/input.js');
  const ids = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert(ids.length > 10, `only found ${ids.length} ids`);

  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = ids.filter((id) => !htmlIds.has(id));
  assert(missing.length === 0, `index.html is missing: ${missing.join(', ')}`);

  // The reverse direction catches ids the code no longer uses.
  const jsControlled = ['stage', 'help-panel'];
  const unused = [...htmlIds].filter((id) => !ids.includes(id) && !jsControlled.includes(id));
  return `${ids.length} ids verified both ways` + (unused.length ? ` (extra ids present: ${unused.join(', ')})` : '');
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
