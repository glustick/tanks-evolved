/**
 * http.js — the plumbing every route shares: JSON out, bounded JSON in, and the one
 * error shape.
 *
 * An error is a plain Error carrying `status`, a stable machine `code` and a human
 * `message`. The code is what a client branches on; the message is the only thing it
 * ever sees, so messages are written for the player and never built out of internal
 * detail — no stack, no SQL error, no echo of what the caller sent.
 */
'use strict';

/**
 * Build a response-shaped error.
 * @param {number} status HTTP status
 * @param {string} code stable machine-readable identifier
 * @param {string} message text safe to show a user
 * @param {object} [headers] extra response headers (e.g. Retry-After)
 */
function httpError(status, code, message, headers) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (headers) err.headers = headers;
  return err;
}

/** True for the errors this module makes, as opposed to bugs and I/O failures. */
function isHttpError(err) {
  return Boolean(err && typeof err.status === 'number' && typeof err.code === 'string');
}

/**
 * Send a JSON response and end it. Content-Length is set from the encoded bytes
 * rather than characters, which is the difference between a working response and a
 * truncated one the moment a message contains a non-ASCII character.
 */
function sendJson(res, status, body, headers) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    // A JSON error body that a browser decides is HTML is a script-injection
    // primitive. The type here is always right; this stops anything second-guessing it.
    'X-Content-Type-Options': 'nosniff',
    // The answer to an authenticated request is per-session by definition, and nothing
    // in /api is worth a shared cache.
    'Cache-Control': 'no-store'
  }, headers));
  res.end(payload);
}

/** Send a response with no body (status text only) — used by the static handler. */
function sendStatus(res, status, headers) {
  res.writeHead(status, Object.assign({ 'Content-Length': 0 }, headers));
  res.end();
}

/**
 * Returned by a handler that has taken the socket over itself rather than describing a
 * response. The dispatcher's whole contract is that it writes the response, and this is
 * the one documented exception: without it, sendJson would append a JSON body to an open
 * event stream. A symbol rather than a flag on the response, so it cannot collide with
 * anything a handler returns by accident.
 */
const RESPONSE_TAKEN = Symbol('response-taken');

/**
 * Turn a response into a Server-Sent Events stream.
 *
 * The headers are flushed immediately rather than with the first event, so the browser's
 * EventSource fires `onopen` — and the client's connection indicator can say "live" —
 * without waiting for somebody else to do something in the lobby.
 */
function openEventStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // Per-session by definition: an intermediary that cached this would replay one
    // player's events to another.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'keep-alive',
    // nginx buffers proxied responses by default, which for a stream that changes once a
    // minute means the client sees nothing until the buffer fills.
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  // A socket that dies between events would otherwise emit its EPIPE here, and an
  // unhandled 'error' on a response is an uncaught exception. The stream's own 'close'
  // handler is what cleans up; this only stops the noise.
  res.on('error', () => {});

  return res;
}

/**
 * Write one SSE event. JSON.stringify never emits a raw newline, so the data field is
 * always a single line and needs no escaping beyond that.
 */
function writeEvent(res, event, data) {
  if (!isWritable(res)) return false;
  return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** A comment line: SSE's keepalive. Invisible to the client, but it keeps the socket warm. */
function writeComment(res, text) {
  if (!isWritable(res)) return false;
  return res.write(`: ${text}\n\n`);
}

/** Whether a response can still take bytes. Consumers come and go; the writer does not. */
function isWritable(res) {
  return !res.writableEnded && !res.destroyed;
}

/**
 * The peer address, for rate limiting and the access log.
 *
 * Deliberately not X-Forwarded-For: nothing here is configured with a trusted proxy,
 * so that header is entirely client-controlled and honouring it would let one client
 * reset its own rate limit by inventing a new address per request.
 */
function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Read and parse a JSON request body, refusing anything that does not declare itself
 * JSON and refusing to buffer more than `limit` bytes.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit maximum accepted body size in bytes
 * @returns {Promise<object>} the parsed object; rejects with an httpError otherwise
 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] || '';
    if (!/^application\/json\b/i.test(type)) {
      reject(httpError(415, 'unsupported_media_type', 'send the request body as application/json'));
      return;
    }

    // A declared length over the limit is worth trusting to this extent: it is
    // cheaper to refuse a body nobody has sent yet than to read it. It is never
    // *believed* — a client can lie or omit it, which is what the counter below is for.
    const declared = Number(req.headers['content-length']);
    if (Number.isInteger(declared) && declared > limit) {
      reject(httpError(413, 'payload_too_large', `request body must be at most ${limit} bytes`));
      return;
    }

    const chunks = [];
    let size = 0;
    let overflowed = false;

    function onData(chunk) {
      if (overflowed) return;
      size += chunk.length;
      if (size > limit) {
        overflowed = true;
        // Stop consuming, but do not destroy the socket here: that would also kill the
        // 413 on its way out. Node tears the connection down itself once a response
        // ends while the request body is still unread.
        req.pause();
        reject(httpError(413, 'payload_too_large', `request body must be at most ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      if (overflowed) return; // already rejected
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(httpError(400, 'invalid_json', 'the request body is not valid JSON'));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(httpError(400, 'invalid_json', 'the request body must be a JSON object'));
        return;
      }
      resolve(parsed);
    }

    function onError() {
      reject(httpError(400, 'bad_request', 'could not read the request body'));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

module.exports = {
  httpError,
  isHttpError,
  sendJson,
  sendStatus,
  openEventStream,
  writeEvent,
  writeComment,
  RESPONSE_TAKEN,
  clientIp,
  readJsonBody
};
