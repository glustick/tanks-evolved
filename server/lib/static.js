/**
 * static.js — the client, served from the same origin as the API.
 *
 * The rule is an allowlist, not a document root. The repository root also holds server/
 * (this code and the SQLite database) and tools/, and pointing a file server at it would
 * publish both over HTTP. Naming three prefixes is cheaper to keep correct than serving a
 * document root and maintaining a list of things to exclude from it.
 *
 * Anything not on the list is not a 404: it falls through to index.html. The game has no
 * router, so an unknown path is a stale bookmark or a shared URL with an extra segment,
 * and serving the shell means the game still boots.
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { sendStatus } = require('./http');

// The MIME types the client actually ships. nginx gets these from mime.types; there is
// no such file here, and a wrong Content-Type on a stylesheet is a broken page that
// still answers 200, so the mapping is explicit rather than inferred.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

// index.html and one flat directory level under css/ and js/. No `..` and no path
// separator can match, and the lookahead keeps dotfiles out of a served directory.
const SERVABLE = [/^index\.html$/, /^(?:css|js)\/(?!\.)[A-Za-z0-9._-]+$/];

const FALLBACK = 'index.html';

/**
 * Two cache rules, for the same reason: index.html carries the
 * build's version and must be revalidated, while css/ and js/ keep byte-identical URLs
 * between releases so they cannot use a long immutable TTL. `no-cache` is not `no-store`
 * — the browser may keep its copy but has to revalidate, so a repeat visit costs a 304
 * instead of the whole page.
 */
function cacheControlFor(rel) {
  return rel === FALLBACK ? 'no-cache' : 'public, max-age=3600';
}

function mimeFor(rel) {
  return MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream';
}

/** Whether a relative path is one of the files this server is willing to hand out. */
function isServable(rel) {
  return SERVABLE.some((pattern) => pattern.test(rel));
}

function baseHeaders(rel) {
  return {
    'Content-Type': mimeFor(rel),
    'Cache-Control': cacheControlFor(rel),
    // An HTML file served with a browser-guessed type is how a text file becomes a
    // script; every type above is already correct, and this keeps it that way.
    'X-Content-Type-Options': 'nosniff'
  };
}

/** Headers only, for a 304. No Content-Length: this response must not have a body. */
function sendNotModified(res, rel, mtime) {
  res.writeHead(304, Object.assign(baseHeaders(rel), { 'Last-Modified': mtime.toUTCString() }));
  res.end();
}

/** Stream a file, honouring If-Modified-Since so a cached page costs a 304. */
function sendFile(req, res, absPath, rel, stat) {
  const mtime = stat.mtime;
  const since = Date.parse(req.headers['if-modified-since'] || '');
  // HTTP dates have one-second resolution and mtime does not, so the comparison is
  // against the second the file was last written rather than its full timestamp.
  if (Number.isFinite(since) && Math.floor(mtime.getTime() / 1000) * 1000 <= since) {
    sendNotModified(res, rel, mtime);
    return;
  }

  const headers = Object.assign(baseHeaders(rel), {
    'Content-Length': stat.size,
    'Last-Modified': mtime.toUTCString()
  });

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(absPath);
  // A read that fails mid-response cannot be turned into an error status — the headers
  // are already on the wire — so the connection is cut instead of left hanging.
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/**
 * Resolve what to serve for a pathname.
 * @returns {string} a path relative to the repository root
 */
function resolveRelative(pathname) {
  const trimmed = pathname.replace(/^\/+/, '');
  const rel = trimmed === '' ? FALLBACK : trimmed;
  return isServable(rel) ? rel : FALLBACK;
}

/**
 * Serve one non-API request.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} config
 * @param {string} pathname the decoded path, with the query string already dropped
 */
async function serve(req, res, config, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendStatus(res, 405, { Allow: 'GET, HEAD' });
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request\n');
    return;
  }

  const rel = resolveRelative(decoded);
  const absPath = path.resolve(config.repoRoot, rel);

  // Belt and braces: the allowlist cannot match a traversal, and this makes sure a
  // future edit to it cannot quietly become one.
  if (absPath !== path.join(config.repoRoot, rel)) {
    logger.error(`refusing to serve a path outside the repository root: ${rel}`);
    res.writeHead(403, { 'Content-Length': 0 });
    res.end();
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    stat = null;
  }

  if (!stat || !stat.isFile()) {
    // A missing asset is a broken checkout or a truncated image, not a player's typo.
    // The shell cannot stand in for it, so this one is a real 404.
    logger.error(`static file is missing from the image: ${rel}`);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
    return;
  }

  sendFile(req, res, absPath, rel, stat);
}

module.exports = { serve, isServable, mimeFor, cacheControlFor, MIME, FALLBACK };
