/**
 * screens.js — the register / login screen and the lobby, over the top of the game.
 *
 * Three things this file is careful about:
 *
 *  - **It is never in the way.** The game behind these screens is already running and
 *    already playable. Nothing here opens a screen until a server has answered a
 *    question, and "Play locally" hides everything again whatever state the lobby is in.
 *  - **Server text is text.** Names, ids and messages are written with textContent, never
 *    innerHTML: another player's display name is a string this page did not author, and
 *    the one place that matters is the one place a list of them is rendered.
 *  - **The stream is the truth.** Buttons send a request and then render the answer; the
 *    event stream renders the same payload shape whenever anything changes, including
 *    changes made from another tab or by another player. One render path, two sources.
 *
 * The only element ids this file touches are in REQUIRED_IDS, and tools/check-static.js
 * asserts they all exist in index.html — the same contract input.js has for the HUD.
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});

  /** Every element the screens touch. Verified by the static check and the self-test. */
  var REQUIRED_IDS = [
    'net-chip', 'net-status',
    'auth-screen', 'auth-title', 'auth-subtitle', 'auth-form', 'auth-email', 'auth-password',
    'auth-error', 'auth-submit', 'auth-toggle', 'auth-local',
    'lobby-screen', 'lobby-who', 'lobby-error', 'logout-btn', 'lobby-local',
    'lobby-count', 'lobby-games', 'lobby-empty', 'lobby-refresh',
    'host-btn', 'queue-btn', 'queue-state',
    'my-game', 'my-game-title', 'my-game-meta', 'my-game-load', 'my-game-cancel'
  ];

  /** How the connection indicator reads. Keys are the stream's own states. */
  var CONNECTION_LABELS = {
    local: 'LOCAL',
    offline: 'OFFLINE',
    connecting: 'RECONNECTING',
    live: 'LIVE'
  };

  /** The chip is a button: clicking it is how a player gets back to the lobby. */
  var CONNECTION_TITLES = {
    local: 'No server here — local hot-seat play',
    offline: 'No live connection — sign in, or play locally',
    connecting: 'Reconnecting to the server',
    live: 'Connected — open the lobby'
  };

  var state = {
    doc: null,
    app: null,
    els: {},
    me: null,
    lobby: null,
    game: null,
    stream: null,
    connection: 'local',
    mode: 'signin'
  };

  function pick(doc, id) {
    return doc && doc.getElementById ? doc.getElementById(id) : null;
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function setClass(node, name, on) {
    if (!node || !node.classList) return;
    if (on) node.classList.add(name); else node.classList.remove(name);
  }

  function show(node, visible) {
    if (node) node.hidden = !visible;
  }

  /**
   * A relative timestamp for a game in the list. A clock reading is fine here: this is
   * presentation, and the simulation's no-clock rule is about the match, not about the
   * lobby.
   */
  function ago(when, nowMs) {
    var seconds = Math.max(0, Math.round((nowMs - when) / 1000));
    if (seconds < 10) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + ' min ago';
    return Math.round(minutes / 60) + 'h ago';
  }

  /** Whether a screen is covering the board: the game's keyboard shortcuts yield to it. */
  function isOpen() {
    return (state.els['auth-screen'] && !state.els['auth-screen'].hidden)
      || (state.els['lobby-screen'] && !state.els['lobby-screen'].hidden);
  }

  // ------------------------------------------------------------------ connection

  function setConnection(status) {
    state.connection = status;
    setText(state.els['net-status'], CONNECTION_LABELS[status] || status.toUpperCase());
    setClass(state.els['net-chip'], 'is-live', status === 'live');
    setClass(state.els['net-chip'], 'is-offline', status === 'offline');
    setClass(state.els['net-chip'], 'is-local', status === 'local');
    if (state.els['net-chip']) state.els['net-chip'].title = CONNECTION_TITLES[status] || '';
  }

  // --------------------------------------------------------------------- screens

  function openAuth(message) {
    show(state.els['auth-screen'], true);
    show(state.els['lobby-screen'], false);
    showError(state.els['auth-error'], message);
    var field = state.els['auth-password'];
    if (field) field.value = '';
  }

  function openLobby() {
    show(state.els['auth-screen'], false);
    show(state.els['lobby-screen'], true);
    if (state.lobby) renderLobby(state.lobby, true);
  }

  function playLocally() {
    show(state.els['auth-screen'], false);
    show(state.els['lobby-screen'], false);
  }

  function setMode(mode) {
    state.mode = mode;
    var registering = mode === 'register';
    setText(state.els['auth-title'], registering ? 'Create an account' : 'Sign in');
    setText(state.els['auth-subtitle'], registering
      ? 'An email and a password is the whole of it. Your email is never shown to another player.'
      : 'Sign in to play online. Local hot-seat is one click away either way.');
    setText(state.els['auth-submit'], registering ? 'Create account' : 'Sign in');
    setText(state.els['auth-toggle'], registering ? 'I already have an account' : 'Create an account');
    if (state.els['auth-password']) {
      state.els['auth-password'].setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
    }
    showError(state.els['auth-error'], null);
  }

  function showError(node, message) {
    if (!node) return;
    setText(node, message || '');
    show(node, Boolean(message));
  }

  // ------------------------------------------------------------------- rendering

  /** Render one of the two payload shapes the server sends: the lobby, or `you`. */
  function renderLobby(payload, keepError) {
    if (!payload) return;
    state.lobby = payload;
    if (payload.you && payload.you.player) state.me = payload.you.player;

    setText(state.els['lobby-who'], state.me ? 'signed in as ' + state.me.displayName : '');
    renderGames(payload.games || []);
    renderQueue(Boolean(payload.you && payload.you.waiting), payload.queue ? payload.queue.count : 0);
    renderMyGame(payload.you ? payload.you.game : null);
    renderActions(payload.you ? payload.you.game : null);
    if (!keepError) showError(state.els['lobby-error'], null);
  }

  /**
   * The two ways into a game are both refused while this player is hosting one that
   * nobody has joined: the server says so with a 409, and a button that cannot work
   * should say so before it is pressed rather than after.
   */
  function renderActions(game) {
    var hosting = Boolean(game && game.status === 'open');
    if (state.els['host-btn']) state.els['host-btn'].disabled = hosting;
    if (state.els['queue-btn']) state.els['queue-btn'].disabled = hosting;
  }

  /**
   * The open games list.
   *
   * Built with createElement and textContent rather than markup: a display name comes
   * from another account, and this is the one place in the client where a string the
   * page did not write ends up in the document.
   */
  function renderGames(games) {
    var list = state.els['lobby-games'];
    if (!list) return;
    var now = Date.now();
    var mine = state.me ? state.me.id : null;

    while (list.firstChild) list.removeChild(list.firstChild);

    for (var i = 0; i < games.length; i++) {
      var game = games[i];
      var row = state.doc.createElement('li');
      row.className = 'lobby-row';
      row.setAttribute('data-game', String(game.id));

      var name = state.doc.createElement('span');
      name.className = 'lobby-name';
      name.textContent = game.host.displayName;
      row.appendChild(name);

      var meta = state.doc.createElement('span');
      meta.className = 'lobby-meta';
      meta.textContent = '#' + game.id + ' \u00b7 ' + ago(game.createdAt, now);
      row.appendChild(meta);

      var join = state.doc.createElement('button');
      join.className = 'btn tiny';
      join.type = 'button';
      join.textContent = game.host.id === mine ? 'Yours' : 'Join';
      join.disabled = game.host.id === mine;
      // The listener closes over the id rather than reading it back out of the DOM: the
      // row can be replaced by the next event between a click and its handler.
      join.addEventListener('click', (function (id) { return function () { joinGame(id); }; })(game.id));
      row.appendChild(join);

      list.appendChild(row);
    }

    setText(state.els['lobby-count'], String(games.length));
    show(state.els['lobby-empty'], games.length === 0);
  }

  function renderQueue(waiting, count) {
    setText(state.els['queue-state'], waiting
      ? 'waiting for an opponent\u2026'
      : (count > 0 ? count + ' player' + (count === 1 ? '' : 's') + ' waiting' : ''));
    setClass(state.els['queue-btn'], 'is-waiting', waiting);
    setText(state.els['queue-btn'], waiting ? 'Leave the queue' : 'Quick match');
    if (state.els['queue-btn'] && state.els['queue-btn'].setAttribute) {
      state.els['queue-btn'].setAttribute('aria-pressed', waiting ? 'true' : 'false');
    }
  }

  function renderMyGame(game) {
    var panel = state.els['my-game'];
    if (!panel) return;
    state.game = game || null;
    if (!game) {
      show(panel, false);
      return;
    }
    show(panel, true);

    var opponent = game.host.id === (state.me ? state.me.id : null) ? game.guest : game.host;
    setText(state.els['my-game-title'], game.status === 'open'
      ? 'Waiting for an opponent'
      : 'Matched with ' + (opponent ? opponent.displayName : 'your opponent'));

    var parts = ['game #' + game.id, game.status];
    if (game.seed) parts.push('seed ' + game.seed);
    setText(state.els['my-game-meta'], parts.join(' \u00b7 '));

    // Only an open game can be cancelled, and only by the player hosting it.
    var cancellable = game.status === 'open' && game.host.id === (state.me ? state.me.id : null);
    show(state.els['my-game-cancel'], cancellable);
    show(state.els['my-game-load'], Boolean(game.seed));
  }

  // -------------------------------------------------------------------- actions

  /**
   * Every call's shared epilogue.
   *
   * A 401 belongs to one of two different stories, and they are told differently: on any
   * ordinary call it means the session is gone and the screen has to change; on the
   * sign-in call itself it means the credentials were wrong, which is a message in a form
   * and not a reason to throw the form away.
   */
  function onResult(result, messageNode, isAuthCall) {
    if (result.api && result.status === 401 && !isAuthCall) {
      endSession();
      showError(state.els['auth-error'], 'your session has expired — sign in again');
      return false;
    }
    if (!result.ok) {
      showError(messageNode, TE.net.errorMessage(result, 'that did not work (' + result.status + ')'));
      return false;
    }
    return true;
  }

  /** A call that never reached the server: the lobby says so, and local play continues. */
  function onFailure(err, messageNode) {
    setConnection('offline');
    showError(messageNode, TE.net.failureMessage(err));
  }

  function refreshLobby() {
    return TE.net.lobby().then(function (result) {
      if (onResult(result, state.els['lobby-error'])) renderLobby(result.json);
    }, function (err) { onFailure(err, state.els['lobby-error']); });
  }

  function hostGame() {
    return TE.net.host().then(function (result) {
      if (onResult(result, state.els['lobby-error'])) refreshLobby();
    }, function (err) { onFailure(err, state.els['lobby-error']); });
  }

  function joinGame(id) {
    return TE.net.join(id).then(function (result) {
      if (onResult(result, state.els['lobby-error'])) refreshLobby();
    }, function (err) { onFailure(err, state.els['lobby-error']); });
  }

  function cancelGame() {
    var game = state.lobby && state.lobby.you ? state.lobby.you.game : null;
    if (!game) return null;
    return TE.net.cancel(game.id).then(function (result) {
      if (onResult(result, state.els['lobby-error'])) refreshLobby();
    }, function (err) { onFailure(err, state.els['lobby-error']); });
  }

  function toggleQueue() {
    var waiting = Boolean(state.lobby && state.lobby.you && state.lobby.you.waiting);
    var call = waiting ? TE.net.leaveQueue() : TE.net.queue();
    return call.then(function (result) {
      if (onResult(result, state.els['lobby-error'])) refreshLobby();
    }, function (err) { onFailure(err, state.els['lobby-error']); });
  }

  /**
   * Put the server's seed on the local board.
   *
   * Phase 2 stops here: a match says which map both players are on, and the board is the
   * one the client has always had. Playing a networked round is Phase 3.
   */
  function loadSeed() {
    var seed = state.game ? state.game.seed : null;
    if (!seed || !state.app) return;
    playLocally();
    TE.game.reset(state.app.game, seed);
    TE.render.setSeed(state.app.renderer, seed);
    if (state.app.controller && state.app.controller.els['seed-input']) {
      state.app.controller.els['seed-input'].value = seed;
    }
    if (state.app.controller) state.app.controller.refresh(true);
  }

  function submitAuth() {
    var email = state.els['auth-email'] ? state.els['auth-email'].value : '';
    var password = state.els['auth-password'] ? state.els['auth-password'].value : '';
    if (email.trim().length === 0 || password.length === 0) {
      showError(state.els['auth-error'], 'an email and a password, please');
      return null;
    }
    setErrorBusy(true);

    var call = state.mode === 'register' ? TE.net.register(email, password) : TE.net.login(email, password);
    return call.then(function (result) {
      if (!onResult(result, state.els['auth-error'], true)) return;
      // The lobby payload carries this player's own name, so a fresh session reads it
      // back rather than guessing one from the address that was just typed.
      return startSession();
    }, function (err) { onFailure(err, state.els['auth-error']); }).then(function () {
      setErrorBusy(false);
    });
  }

  function setErrorBusy(busy) {
    var button = state.els['auth-submit'];
    if (!button) return;
    button.disabled = busy;
    setText(button, busy ? 'Working\u2026' : (state.mode === 'register' ? 'Create account' : 'Sign in'));
  }

  /** Signed in: read the lobby — and our own name with it — then follow the stream. */
  function startSession() {
    return TE.net.lobby().then(function (result) {
      if (!result.api) {
        // Something answered, but it was not this API: a static host, or a proxy with an
        // index.html fallback. No session, no screens, and the board is untouched.
        setConnection('offline');
        return;
      }
      if (result.status === 401) {
        setConnection('offline');
        openAuth('your session has expired — sign in again');
        return;
      }
      if (!result.ok) {
        showError(state.els['auth-error'], TE.net.errorMessage(result, 'the lobby did not answer'));
        return;
      }
      renderLobby(result.json);
      openLobby();
      connectStream();
    }, function (err) { onFailure(err, state.els['auth-error']); });
  }

  function connectStream() {
    if (state.stream) state.stream.close();
    state.stream = TE.net.openStream({
      onStatus: setConnection,
      onEvent: function (name, data) {
        if (name === 'hello' || name === 'lobby') renderLobby(data);
        else if (name === 'queue') renderQueue(Boolean(data.waiting), data.queue ? data.queue.count : 0);
        else if (name === 'match') {
          renderMyGame(data.game);
          showError(state.els['lobby-error'], null);
        }
      }
    });
  }

  function endSession(message) {
    if (state.stream) {
      state.stream.close();
      state.stream = null;
    }
    state.me = null;
    state.lobby = null;
    setConnection('offline');
    openAuth(message);
  }

  function logout() {
    return TE.net.logout().then(function () { endSession(null); }, function () { endSession(null); });
  }

  // --------------------------------------------------------------------- wiring

  function on(node, type, handler) {
    if (node && node.addEventListener) node.addEventListener(type, handler);
  }

  function bind() {
    var els = state.els;

    on(els['net-chip'], 'click', function () {
      // The chip doubles as the way back: whatever the last screen was, if there is a
      // session then the lobby is one click away, and a refresh makes sure it is current.
      if (state.me) { refreshLobby(); openLobby(); }
      else if (state.connection !== 'local') openAuth(null);
    });

    on(els['auth-form'], 'submit', function (event) {
      if (event && event.preventDefault) event.preventDefault();
      submitAuth();
    });
    on(els['auth-toggle'], 'click', function () {
      setMode(state.mode === 'register' ? 'signin' : 'register');
    });
    on(els['auth-local'], 'click', playLocally);
    on(els['lobby-local'], 'click', playLocally);

    on(els['host-btn'], 'click', hostGame);
    on(els['queue-btn'], 'click', toggleQueue);
    on(els['lobby-refresh'], 'click', refreshLobby);
    on(els['my-game-cancel'], 'click', cancelGame);
    on(els['my-game-load'], 'click', loadSeed);
    on(els['logout-btn'], 'click', logout);

    // Escape closes whichever screen is open, the same as the win overlay.
    on(state.doc, 'keydown', function (event) {
      if (event && event.key === 'Escape' && isOpen()) playLocally();
    });
  }

  /**
   * Bring the screens up, if there is anything to bring them up for.
   *
   * The order of these branches is the whole compatibility story: no server protocol
   * means no request and no screens; a server that does not answer means no screens
   * either, and the game is exactly what it would have been offline; only a server that
   * answers decides between "sign in" and "here is the lobby".
   */
  function init(options) {
    var opts = options || {};
    state.doc = opts.document || root.document;
    state.app = opts.app || root.TanksEvolved || null;

    var missing = [];
    for (var i = 0; i < REQUIRED_IDS.length; i++) {
      state.els[REQUIRED_IDS[i]] = pick(state.doc, REQUIRED_IDS[i]);
      if (!state.els[REQUIRED_IDS[i]]) missing.push(REQUIRED_IDS[i]);
    }
    if (missing.length > 0) {
      // A markup mistake must not be able to take the game down with it: the screens are
      // simply not offered, and local play carries on.
      setConnection('local');
      return { missing: missing, mode: 'local' };
    }

    setMode('signin');
    bind();

    if (!TE.net.usable()) {
      setConnection('local');
      return { missing: missing, mode: 'local' };
    }

    setConnection('connecting');
    TE.net.me().then(function (result) {
      // Only a JSON answer from this API counts, and only its own two verdicts: signed in,
      // or not. Anything else — a static host's HTML, a proxy error page, a 5xx — is "no
      // lobby here", which is the offline board rather than a screen that cannot work.
      if (!result.api || (result.status !== 200 && result.status !== 401)) {
        setConnection('offline');
        return;
      }
      if (result.status === 200) { startSession(); return; }
      setConnection('offline');
      openAuth(null);
    }, function (err) {
      // Unreachable: the page may still be served by something that is not this API (any
      // static host), and that must look exactly like playing offline.
      setConnection('offline');
    });

    return { missing: missing, mode: 'online' };
  }

  TE.screens = {
    REQUIRED_IDS: REQUIRED_IDS,
    CONNECTION_LABELS: CONNECTION_LABELS,
    init: init,
    isOpen: isOpen,
    renderLobby: renderLobby,
    setConnection: setConnection,
    playLocally: playLocally,
    // Exposed for the self-test and for a console: the same functions the buttons call.
    refresh: refreshLobby,
    host: hostGame,
    join: joinGame,
    cancel: cancelGame,
    toggleQueue: toggleQueue,
    logout: logout,
    loadSeed: loadSeed,
    state: state
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
