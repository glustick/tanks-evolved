/**
 * net.js — the server, seen from the browser: the /api calls and the event stream.
 *
 * One origin, relative paths, no configuration. The client and the API are served by the
 * same process precisely so that there is no host to get wrong, no CORS preflight, and a
 * session cookie that travels on its own.
 *
 * Nothing here touches the DOM, and nothing here runs when the page was opened from
 * disk — see `usable()`. Local hot-seat is the game's original mode and must not acquire
 * a network dependency: a relative /api/... under file:// is a request the browser will
 * refuse, loudly, and none of that belongs in the console of someone playing offline.
 *
 * Requests use fetch, the stream uses EventSource. Both are same-origin relative.
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});

  var PATHS = {
    me: '/api/me',
    register: '/api/auth/register',
    login: '/api/auth/login',
    logout: '/api/auth/logout',
    lobby: '/api/lobby',
    games: '/api/games',
    queue: '/api/queue',
    stream: '/api/stream'
  };

  // A request that never answers must not leave a button spinning forever. Well above the
  // work any of these endpoints does (the slowest is a scrypt login).
  var REQUEST_TIMEOUT_MS = 8000;

  /**
   * Whether this page can talk to a server at all.
   *
   * Checked before any request is made, not after one fails: under file:// there is no
   * origin to be same-origin with, the request would be refused by the browser, and the
   * refusal shows up in the console and in the headless checks as an error the page
   * never really had. A protocol test answers the question without asking it.
   */
  function usable() {
    return typeof root.fetch === 'function'
      && typeof root.location === 'object'
      && /^https?:$/.test(root.location.protocol);
  }

  /** A fetch with a deadline. AbortController is present everywhere fetch is. */
  function fetchWithDeadline(path, options) {
    if (typeof root.AbortController !== 'function') return root.fetch(path, options);

    var controller = new root.AbortController();
    options.signal = controller.signal;
    var timer = root.setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    var done = function () { root.clearTimeout(timer); };
    return root.fetch(path, options).then(function (res) { done(); return res; },
      function (err) { done(); throw err; });
  }

  /**
   * One API call.
   *
   * Resolves for every answer the server gave, failures included: a 401 or a 409 is a
   * result a screen has to show, not an exception to swallow. It rejects only when the
   * request itself did not happen — which is the one case the caller has to report as
   * "the server is not there".
   *
   * `api` is what separates an answer from *this* API from a page from somewhere else.
   * Any static host with a single-page fallback (the plain nginx image in this repository
   * is one) answers a 200 with the game's own HTML for /api/me, which would otherwise
   * read as "signed in" and put an empty lobby on screen.
   */
  function request(method, path, body) {
    var options = { method: method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    return fetchWithDeadline(path, options).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        try {
          json = JSON.parse(text);
        } catch (err) {
          // Not JSON, so not this API — see `api` below.
        }
        var jsonType = /^application\/json\b/i.test(res.headers.get('content-type') || '');
        return { ok: res.ok, status: res.status, json: json, api: jsonType && json !== null };
      });
    });
  }

  /** What to tell a player when the request never reached the server. */
  function failureMessage(err) {
    if (err && err.name === 'AbortError') return 'the server took too long to answer';
    return 'cannot reach the server';
  }

  /** The message from an error body, which the server writes for a player to read. */
  function errorMessage(result, fallback) {
    if (result && result.json && typeof result.json.message === 'string') return result.json.message;
    return fallback;
  }

  /** A game id from the server, made safe to put in a path. */
  function gamePath(id) {
    return PATHS.games + '/' + encodeURIComponent(String(Math.floor(Number(id))));
  }

  var api = {
    usable: usable,
    failureMessage: failureMessage,
    errorMessage: errorMessage,

    me: function () { return request('GET', PATHS.me); },
    register: function (email, password) { return request('POST', PATHS.register, { email: email, password: password }); },
    login: function (email, password) { return request('POST', PATHS.login, { email: email, password: password }); },
    logout: function () { return request('POST', PATHS.logout); },

    lobby: function () { return request('GET', PATHS.lobby); },
    host: function () { return request('POST', PATHS.games); },
    join: function (id) { return request('POST', gamePath(id) + '/join'); },
    cancel: function (id) { return request('DELETE', gamePath(id)); },
    game: function (id) { return request('GET', gamePath(id)); },
    queue: function () { return request('POST', PATHS.queue); },
    leaveQueue: function () { return request('DELETE', PATHS.queue); }
  };

  // -------------------------------------------------------------- event stream

  /**
   * Open the server-sent event stream.
   *
   * EventSource rather than a reader loop, because reconnecting is most of what this
   * needs to do: the browser retries a dropped connection by itself and tells us which of
   * the three states we are in. `connecting` is a retry in progress, `live` is a stream
   * the server has accepted, and `offline` is a stream that will not come back on its own
   * — which is also what a signed-out tab gets, since the server answers 401 and the
   * browser stops rather than retrying into the same refusal.
   *
   * @param {{onEvent: function(string, object), onStatus: function(string)}} handlers
   * @returns {{close: function()}}
   */
  function openStream(handlers) {
    if (typeof root.EventSource !== 'function') {
      handlers.onStatus('offline');
      return { close: function () {} };
    }

    var source = new root.EventSource(PATHS.stream);

    function listen(name) {
      source.addEventListener(name, function (event) {
        var data = null;
        try {
          data = JSON.parse(event.data);
        } catch (err) {
          return; // a garbled event is dropped rather than allowed to break the screen
        }
        handlers.onEvent(name, data);
      });
    }
    // The four names the server sends. Anything else on this stream is an event from a
    // newer server, which this client ignores by not listening for it.
    listen('hello');
    listen('lobby');
    listen('queue');
    listen('match');

    source.addEventListener('open', function () { handlers.onStatus('live'); });
    source.addEventListener('error', function () {
      var closed = root.EventSource.CLOSED !== undefined && source.readyState === root.EventSource.CLOSED;
      handlers.onStatus(closed ? 'offline' : 'connecting');
    });

    return {
      close: function () {
        source.close();
        handlers.onStatus('offline');
      }
    };
  }

  TE.net = {
    PATHS: PATHS,
    usable: usable,
    failureMessage: failureMessage,
    errorMessage: errorMessage,
    openStream: openStream,
    me: api.me,
    register: api.register,
    login: api.login,
    logout: api.logout,
    lobby: api.lobby,
    host: api.host,
    join: api.join,
    cancel: api.cancel,
    game: api.game,
    queue: api.queue,
    leaveQueue: api.leaveQueue
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
