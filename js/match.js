/**
 * match.js — the networked match: two boards, one game, kept in step by relaying shots.
 *
 * The whole design rests on one property of the simulation: a turn is
 * `(seed, playerIndex, move, angle, power)` and both machines produce byte-identical
 * results. So nothing here asks the server what the world looks like. The server relays
 * the move and the aim and compares fingerprints; each client runs the same simulation
 * the other one is running, from the same seed, on the same turns.
 *
 * That is also what makes a reconnect cheap. There is no server-side board to fetch and
 * no snapshot to apply — the seed and the ordered log *are* the board, so rejoining
 * is replaying the log through the same code the live client used. `replay()` below is
 * the only place that does it, and a rejoin and a live turn both go through `applyShot()`,
 * because a catch-up that took a different path could land somewhere else.
 *
 * What "the same state" means precisely, since the fingerprint has to agree exactly:
 * a turn's hash is taken with the move applied, the shooter's aim applied and the shell
 * not yet fired. At that moment both boards hold the same terrain, the same wind, the
 * same tank positions and both tanks' aims — the other player's aim is whatever they
 * last fired, because a locked board cannot change it — so the opponent recomputes the
 * same string before firing the same turn. A mismatch there is the earliest possible
 * sign that the two boards have parted, which is why the receiver checks it on every
 * turn rather than only at the end.
 *
 * What this file is not: it does not decide anything. Whose turn it is, whether a shot is
 * allowed and who won are all the server's answers or the server's comparisons. This end
 * of the wire aims, fires, replays and shows what it was told.
 */
(function (root) {
  'use strict';

  var TE = (root.TE = root.TE || {});

  /** Every element this file touches. Verified by tools/check-static.js. */
  var REQUIRED_IDS = [
    'match-panel', 'match-title', 'match-opponent', 'match-status', 'match-lobby',
    'chat-log', 'chat-form', 'chat-input', 'chat-send', 'chat-error',
    'modal-lobby-btn'
  ];

  /** How the opponent's presence reads. The payload carries a boolean per seat, not a state. */
  var PRESENCE_LABELS = { present: 'connected', away: 'away' };

  /**
   * How long to leave a submitted shot alone before letting the player try again.
   *
   * A shot that is never acknowledged — a stream that died between the request and the
   * event — would otherwise lock the board until the page was reloaded. Longer than any
   * reasonable round trip, short enough that a player notices the retry rather than
   * giving up.
   */
  var SHOT_TIMEOUT_MS = 8000;

  var state = {
    doc: null,
    app: null,
    screens: null,
    els: {},

    /** The game row as the server describes it, and everything around it. */
    payload: null,
    game: null,
    shots: [],
    messages: [],
    turn: 1,
    activeUserId: null,
    presence: { host: false, guest: false },

    /** Set while a shot is in flight to the server, and cleared by the event or the timer. */
    pending: false,
    pendingTimer: null,
    /** Local observation that this board and the relayed one have parted company. */
    desynced: false,
    reported: false,
    lastVerdict: null,
    error: null
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

  function showError(node, message) {
    if (!node) return;
    setText(node, message || '');
    show(node, Boolean(message));
  }

  // --------------------------------------------------------------------- seats

  /**
   * The signed-in player.
   *
   * Read through screens.js rather than copied into this file: the session is that
   * module's, it can start and end without this panel being rebuilt, and a match that
   * cached "me" at the moment it began would keep aiming at a seat that is no longer
   * anybody's — which is exactly the bug this shape exists to prevent.
   */
  function me() {
    var screens = state.screens || TE.screens;
    return (screens && screens.state && screens.state.me) || null;
  }

  /** Whether the caller is the host. */
  function amHost() {
    var who = me();
    return Boolean(who && state.game && state.game.host.id === who.id);
  }

  /** The other player, or null while the seat is still empty. */
  function opponent() {
    if (!state.game) return null;
    return amHost() ? state.game.guest : state.game.host;
  }

  function opponentPresent() {
    if (!state.game) return false;
    return amHost() ? state.presence.guest : state.presence.host;
  }

  function myTurn() {
    var who = me();
    return Boolean(state.game && who && state.activeUserId === who.id);
  }

  function isActive() {
    return state.game !== null;
  }

  function gameId() {
    return state.game ? state.game.id : null;
  }

  // --------------------------------------------------------------- simulation

  /**
   * Apply one relayed turn to the local board: drive the tank, set the shooter's aim,
   * fingerprint the result, fire, and let it land.
   *
   * The move goes on first, and before the hash is read, because that is the board the
   * turn is committed from: the shooter has already spent the turn driving on its own
   * machine, so what the opponent has to reproduce is the position after the driving,
   * not before it. Applying a move twice is the same as applying it once (js/game.js
   * applyMove measures from the turn's opening frame), which is why the shooter's own
   * board can take this path unchanged rather than being a special case.
   *
   * The aim is *set from the message* rather than read from the tank, so the board does
   * not depend on whether this client happens to have the same numbers sliders: what is
   * simulated is what the shooter actually fired, not what this client last saw.
   *
   * The returned hash is the one both machines should agree on — see the header.
   */
  function applyShot(game, shot) {
    var tank = game.world.tanks[game.world.activeIndex];
    TE.game.applyMove(game, shot.move || 0);
    TE.tank.setAngle(tank, shot.angle);
    TE.tank.setPower(tank, shot.power);
    var hash = TE.game.stateHash(game);
    TE.game.fire(game);
    TE.game.settle(game);
    return hash;
  }

  /**
   * Rebuild the board from the seed and the shot log.
   *
   * Every shot is checked against the hash the server stored with it, so a board that
   * diverges during a replay is noticed at the turn it diverged rather than at the end
   * of the match. A mismatch is recorded, not corrected: this client has no way to know
   * which of the two boards is the wrong one, and inventing a third would be worse.
   */
  function replay(shots) {
    var game = state.app.game;
    var mismatches = [];
    for (var i = 0; i < shots.length; i++) {
      var hash = applyShot(game, shots[i]);
      if (shots[i].stateHash && hash !== shots[i].stateHash) mismatches.push(shots[i].turn);
    }
    if (mismatches.length > 0) {
      state.desynced = true;
      state.error = 'this board did not match the relayed one on turn' +
        (mismatches.length === 1 ? ' ' : 's ') + mismatches.join(', ');
    }
    return mismatches;
  }

  // ------------------------------------------------------------------ render

  function renderStatus() {
    if (!state.game) return;
    var world = state.app ? state.app.game.world : null;
    var text;

    if (state.game.status === 'finished') {
      text = state.game.desync ? 'match ended: the two boards disagreed'
        : (state.game.winner ? state.game.winner.displayName + ' wins' : 'draw');
    } else if (!opponentPresent()) {
      text = 'waiting for ' + (opponent() ? opponent().displayName : 'your opponent') + ' to come back\u2026';
    } else if (world && world.state === 'flying') {
      text = 'shell in flight\u2026';
    } else if (world && world.state === 'settling') {
      text = 'impact\u2026';
    } else if (myTurn()) {
      text = 'your turn \u2014 aim and fire';
    } else {
      text = 'waiting for ' + (opponent() ? opponent().displayName : 'your opponent') + '\u2026';
    }

    if (state.pending) text = 'sending your shot\u2026';
    if (state.error) text = state.error;
    setText(state.els['match-status'], text);
    setClass(state.els['match-status'], 'is-mine', myTurn() && !state.pending);
  }

  function renderPanel() {
    if (!state.game) return;
    var other = opponent();

    setText(state.els['match-title'], 'Game #' + state.game.id +
      (state.game.seed ? ' \u00b7 ' + state.game.seed : ''));
    setText(state.els['match-opponent'], other
      ? other.displayName + ' \u2014 ' + PRESENCE_LABELS[opponentPresent() ? 'present' : 'away']
      : 'waiting for an opponent');
    setClass(state.els['match-opponent'], 'is-away', Boolean(other) && !opponentPresent());
    renderStatus();
  }

  /** The chat log. Built with createElement/textContent — the text is somebody else's. */
  function renderChat() {
    var log = state.els['chat-log'];
    if (!log || !state.doc) return;

    while (log.firstChild) log.removeChild(log.firstChild);

    var mine = me();
    for (var i = 0; i < state.messages.length; i++) {
      var message = state.messages[i];
      var line = state.doc.createElement('li');
      line.className = 'chat-line' + (mine && message.userId === mine.id ? ' is-mine' : '');

      var who = state.doc.createElement('span');
      who.className = 'chat-who';
      who.textContent = mine && message.userId === mine.id ? 'you' : nameOf(message.userId);
      line.appendChild(who);

      var body = state.doc.createElement('span');
      body.className = 'chat-body';
      body.textContent = message.text;
      line.appendChild(body);

      log.appendChild(line);
    }

    // The newest message is the one being waited for, so the log reads bottom-up without
    // a scrollbar to find it.
    if (log.scrollTop !== undefined) log.scrollTop = log.scrollHeight;
  }

  function nameOf(userId) {
    if (!state.game) return 'player';
    if (state.game.host.id === userId) return state.game.host.displayName;
    if (state.game.guest && state.game.guest.id === userId) return state.game.guest.displayName;
    return 'player';
  }

  /**
   * The one function a state change goes through, whether it came from a response or
   * from the stream. Two sources, one render path — the same rule screens.js follows.
   */
  function apply(payload, options) {
    var opts = options || {};
    if (!payload || !payload.game) return;

    var isNew = !state.game || state.game.id !== payload.game.id;
    // A rebuild is a game this client is already playing, put back on the board from the
    // log. A resync asks for one unconditionally: it is called precisely when this client
    // does not trust its board, and "the log has not grown" is not the same as "the board
    // is right" — a board can be wrong with the same log on it.
    var rebuild = isNew || opts.rebuild === true;
    state.payload = payload;
    state.game = payload.game;
    state.shots = payload.shots || [];
    state.messages = payload.messages || [];
    state.turn = payload.turn;
    state.activeUserId = payload.activeUserId;
    state.presence = payload.presence || { host: false, guest: false };

    if (rebuild) {
      // Put the game on the board from the seed and the log. This is the reconnect path,
      // the join path and the recovery path at once, which is why there is only one of
      // them: a catch-up that took a different route could land somewhere else.
      //
      // The aim of the tank that is to move is carried across, but only when that tank is
      // this player's own: it is the one piece of the board that is nobody else's business
      // — the opponent's board cannot know the aim being lined up, and it is in no log —
      // so without this a stream hiccup mid-aim would silently reset the shot. The other
      // tank's aim is not this player's to invent, so it comes from the log like the rest.
      // The driving lined up so far travels with the aim, for the same reason: it is the
      // same player's decision about the same turn and it is in no log either.
      var activeIndex = state.app.game.world.activeIndex;
      var carried = {
        angle: state.app.game.world.tanks[activeIndex].angle,
        power: state.app.game.world.tanks[activeIndex].power,
        move: TE.game.pendingMove(state.app.game)
      };

      state.app.controller.setFireHandler(sendShot);
      TE.game.reset(state.app.game, payload.game.seed);
      TE.render.setSeed(state.app.renderer, payload.game.seed);
      replay(state.shots);

      var board = state.app.game.world;
      if (!isNew && board.state === 'aiming' && board.activeIndex === activeIndex && myTurn()) {
        TE.tank.setAngle(board.tanks[activeIndex], carried.angle);
        TE.tank.setPower(board.tanks[activeIndex], carried.power);
        TE.game.applyMove(state.app.game, carried.move);
      }
    }

    renderPanel();
    renderChat();
    lockBoard();
    checkFinished();
    if (state.els['match-panel']) show(state.els['match-panel'], true);
  }

  /**
   * Whose board this is, right now.
   *
   * Locked whenever the board is not this player's to move: not their turn, a shell still
   * in the air, a shot already sent and waiting to be relayed, the opponent away, or the
   * match over. The server refuses a shot out of turn as well — this is what stops the
   * player from being able to try.
   */
  function lockBoard() {
    var controller = state.app && state.app.controller;
    if (!controller || !controller.setLock) return;

    var world = state.app.game.world;
    var reason = null;
    if (!state.game || state.game.status !== 'playing') reason = 'the match is over';
    else if (state.pending) reason = 'your shot is on its way';
    else if (!myTurn()) reason = 'not your turn';
    else if (world.state !== 'aiming') reason = 'the shell is still in the air';
    else if (!opponentPresent()) reason = 'your opponent is away';

    controller.setLock(reason);
  }

  /**
   * The match has ended on this board: tell the server what this client saw.
   *
   * Both players report, and the server accepts the match as finished only when the two
   * reports agree — the winner *and* the board. One report is half of that, which is the
   * point: a client that won and says so, with nothing to check it against, would be the
   * server taking somebody's word for the score.
   */
  function checkFinished() {
    if (state.game.status !== 'playing' || !state.app) return;
    if (state.app.game.world.state !== 'over') return;
    if (state.reported) return;

    state.reported = true;
    var winnerId = null;
    var world = state.app.game.world;
    if (world.winner === 1) winnerId = state.game.host.id;
    else if (world.winner === 2) winnerId = state.game.guest ? state.game.guest.id : null;

    var hash = TE.game.stateHash(state.app.game);
    TE.net.reportResult(gameId(), winnerId, hash).then(function (result) {
      if (!result.ok) {
        state.error = 'the result could not be recorded: ' + TE.net.errorMessage(result, 'the server said no');
        renderStatus();
        return;
      }
      state.lastVerdict = result.json;
      if (result.json && result.json.waiting) {
        state.error = null;
        renderStatus();
        setText(state.els['match-status'], 'result sent \u2014 waiting for your opponent to agree');
      }
    }, function (err) {
      state.error = 'the result did not reach the server (' + TE.net.failureMessage(err) + ')';
      renderStatus();
    });
  }

  // ------------------------------------------------------------------ actions

  /**
   * Fire: hand the turn to the server and wait for it to come back.
   *
   * Nothing moves on this board once the turn has been sent, and that is deliberate — the
   * event is applied by the same code on both machines, so the shooter is not a special
   * case with its own path onto the board. What is sent is the turn: the driving spent
   * (the board has already moved, because the player had to see where they were aiming
   * from), the aim, and the fingerprint of the board as it is now — with the move applied,
   * the aim applied and the shell not yet fired. The opponent recomputes exactly that
   * string before firing the same turn.
   *
   * The opponent sees the whole turn at once rather than watching the tank drive: the
   * move is relayed with the shot, not as it happens. That is the price of a turn being
   * one entry in the log, and it is the right price — a turn is one decision, and a turn
   * that arrived in two pieces would have two moments at which the two boards could part.
   */
  function sendShot() {
    if (!isActive() || state.pending || !myTurn()) return;
    if (state.app.game.world.state !== 'aiming') return;

    var tank = state.app.game.world.tanks[state.app.game.world.activeIndex];
    var hash = TE.game.stateHash(state.app.game);

    state.pending = true;
    state.error = null;
    renderStatus();
    lockBoard();

    armPendingTimeout();

    TE.net.shot(gameId(), TE.game.pendingMove(state.app.game), tank.angle, tank.power, hash)
      .then(function (result) {
      if (!result.ok) {
        // Not pending any more: nothing was relayed, so there is nothing to wait for and
        // the board is the player's again.
        failPending(TE.net.errorMessage(result, 'that shot was refused (' + result.status + ')'));
        return;
      }
      // The response carries the same state the `shot` event does, so a stream that was
      // down when the event went out still leaves this client in step.
      if (result.json) apply(result.json, {});
    }, function (err) {
      failPending('the shot did not reach the server (' + TE.net.failureMessage(err) + ')');
    });
  }

  function armPendingTimeout() {
    clearPendingTimeout();
    state.pendingTimer = root.setTimeout(function () {
      if (!state.pending) return;
      failPending('no answer for your shot \u2014 try firing again');
    }, SHOT_TIMEOUT_MS);
  }

  function clearPendingTimeout() {
    if (state.pendingTimer) root.clearTimeout(state.pendingTimer);
    state.pendingTimer = null;
  }

  function failPending(message) {
    state.pending = false;
    state.error = message;
    clearPendingTimeout();
    renderStatus();
    lockBoard();
    // The shot may have been played after all — a request whose answer never came back is
    // not a request that did not arrive — so the match is fetched rather than assumed. If
    // it was played, this puts the board back in step within a round trip instead of
    // leaving the player behind until they reload.
    resync();
  }

  /**
   * Ask the server for the match again and put the board back on the answer.
   *
   * The recovery path, and the reason the payload carries the whole match rather than the
   * news: a client can be behind without knowing it. A shot request answered but whose
   * answer was lost, a stream down between two turns, a board that has drifted — none of
   * those leave anything to reconcile from the events that were seen. The seed and the
   * log are enough to rebuild the position, so the answer is a replay rather than a guess
   * at which shot was missed.
   *
   * Silent on failure: this is a repair, and a repair that reports its own failure would
   * report it over whatever the player is already looking at. The next event from the
   * stream, or the next shot, goes through the same code path again.
   */
  function resync() {
    if (!isActive()) return null;
    var id = gameId();

    return TE.net.game(id).then(function (result) {
      // A match that ended while this was in flight, or was swept: the stream's own
      // events are the authority on that, not this response.
      if (!result.ok || !state.game || state.game.id !== id) return null;
      state.error = null;
      state.pending = false;
      clearPendingTimeout();
      return apply(result.json, { rebuild: true });
    }, function () {
      return null;
    });
  }

  function sendChat() {
    var field = state.els['chat-input'];
    if (!field || !isActive()) return null;
    var text = String(field.value || '').trim();
    if (text.length === 0) return null;

    // Cleared before the request goes out: the message comes back on the stream and is
    // rendered from there, so leaving it in the box would show it twice if it worked.
    field.value = '';
    showError(state.els['chat-error'], null);

    return TE.net.chat(gameId(), text).then(function (result) {
      if (!result.ok) {
        showError(state.els['chat-error'], TE.net.errorMessage(result, 'that message was refused'));
        // Put it back: the player's sentence is theirs, not the server's to lose.
        if (field.value === '') field.value = text;
      }
    }, function (err) {
      showError(state.els['chat-error'], TE.net.failureMessage(err));
      if (field.value === '') field.value = text;
    });
  }

  // ------------------------------------------------------------------- events

  /**
   * One event from the match. Everything the server sends about a game arrives here;
   * screens.js forwards it and does not interpret any of it.
   */
  function onEvent(name, data) {
    if (name === 'match' || name === 'game') {
      apply(data, {});
      return;
    }
    if (name === 'shot') {
      applyShotEvent(data);
      return;
    }
    if (name === 'turn') {
      // The server's answer to "whose turn is it", which is the one that counts. The
      // board is re-locked on it even when the number has not changed, because the lock
      // also depends on a shell that may still be in the air.
      state.turn = data.turn;
      state.activeUserId = data.activeUserId;
      lockBoard();
      renderStatus();
      return;
    }
    if (name === 'chat') {
      if (data && data.message) {
        state.messages.push(data.message);
        renderChat();
      }
      return;
    }
    if (name === 'opponent') {
      var host = state.game && state.game.host.id === data.userId;
      state.presence[host ? 'host' : 'guest'] = Boolean(data.present);
      renderPanel();
      lockBoard();
      return;
    }
    if (name === 'over' || name === 'desync') {
      apply(data, {});
      showOutcome(name, data);
    }
  }

  /**
   * A relayed shot. The board is moved here and nowhere else, for both players.
   *
   * The local fingerprint is taken after the aim is set and compared with the one that
   * arrived — the check the whole relay exists to make possible. It is not fatal on its
   * own: the outcome is still agreed between the two clients at the end, and a client
   * that declared the match void the moment it disagreed would be making a decision the
   * protocol gives to the two reports.
   */
  function applyShotEvent(data) {
    if (!state.game || !data || !data.shot) return;
    if (data.shot.turn <= state.shots.length) return; // already in the log: applied on replay

    var shot = data.shot;
    var hash = applyShot(state.app.game, shot);
    state.shots.push(shot);
    state.turn = shot.turn + 1;
    state.pending = false;
    clearPendingTimeout();

    if (hash !== shot.stateHash) {
      state.desynced = true;
      state.error = 'boards out of step on turn ' + shot.turn;
    }
    renderStatus();
    lockBoard();
    checkFinished();
  }

  /** The win overlay, told what the server decided rather than what this board thinks. */
  function showOutcome(name, data) {
    var game = data && data.game ? data.game : state.game;
    if (!game) return;

    var title;
    if (name === 'desync' || game.desync) title = 'No result';
    else if (game.winner) title = game.winner.displayName + ' wins';
    else title = 'Draw';

    var detail;
    if (name === 'desync' || game.desync) {
      detail = 'The two boards no longer agreed, so the match was ended without a winner.';
    } else if (data && data.reason === 'walkover') {
      detail = 'Your opponent did not come back, so the match is yours.';
    } else {
      detail = 'Both players agreed on the result.';
    }

    var modalTitle = state.els['match-title'] && state.doc ? state.doc.getElementById('modal-title') : null;
    var modalSub = state.doc ? state.doc.getElementById('modal-sub') : null;
    if (modalTitle && modalSub) {
      setText(modalTitle, title);
      setText(modalSub, detail + ' Seed ' + game.seed + ', ' + state.shots.length + ' shots.');
    }

    setText(state.els['match-status'], name === 'desync' || game.desync
      ? 'match ended without a winner'
      : (game.winner ? game.winner.displayName + ' wins' : 'draw'));
    state.error = null;

    // The way back, offered here and taken away again by leave() the moment the server
    // says the game is no longer live — which is what normally happens, a few milliseconds
    // later, and opens the lobby behind this overlay by itself. What is left is an escape
    // hatch for the case where that event never arrived: a dropped stream, a reload.
    show(state.els['modal-lobby-btn'], true);
  }

  // ------------------------------------------------------------------- wiring

  function on(node, type, handler) {
    if (node && node.addEventListener) node.addEventListener(type, handler);
  }

  function bind() {
    var els = state.els;

    on(els['chat-form'], 'submit', function (event) {
      if (event && event.preventDefault) event.preventDefault();
      sendChat();
    });
    // Enter sends, and the field keeps focus, because a chat box that needs the mouse
    // between every line is not a chat box.
    on(els['chat-input'], 'keydown', function (event) {
      if (event && event.key === 'Enter') return; // the form's own submit handles it
      if (event && event.stopPropagation) event.stopPropagation();
    });
    on(els['match-lobby'], 'click', leave);
    // From the result overlay, the click that lands in the lobby is also the click that
    // dismisses the result — otherwise it would sit there over the lobby.
    on(els['modal-lobby-btn'], 'click', function () {
      hideModalIfOpen();
      leave();
    });
  }

  /**
   * Bring the match UI up. Called once, from the bootstrap, whether or not a match is
   * ever played: the elements and the listeners are cheap, and a panel that arrives with
   * the first match would have to be built inside an event handler.
   */
  function init(options) {
    var opts = options || {};
    state.doc = opts.document || root.document;
    state.app = opts.app || root.TanksEvolved || null;
    state.screens = opts.screens || TE.screens || null;

    var missing = [];
    for (var i = 0; i < REQUIRED_IDS.length; i++) {
      state.els[REQUIRED_IDS[i]] = pick(state.doc, REQUIRED_IDS[i]);
      if (!state.els[REQUIRED_IDS[i]]) missing.push(REQUIRED_IDS[i]);
    }
    if (missing.length > 0) return { missing: missing, active: false };

    bind();
    return { missing: missing, active: false };
  }

  /**
   * Enter a match, or update the one already on the board.
   *
   * `payload` is the server's whole description of it — from `match`, from `game`, or
   * from GET /api/games/:id — so this is the same call for a player who was just matched,
   * one who reloaded mid-match, and one whose turn just came round again.
   */
  function enter(payload) {
    if (!payload || !payload.game) return null;
    apply(payload, {});
    return state.game;
  }

  /**
   * Stop playing the networked match and put the board back in the player's hands.
   *
   * The board is left exactly where the match left it — it is a finished position, and
   * the player is entitled to look at it. What changes is that the controls belong to
   * whoever is holding the mouse again, which is what the unlock is for.
   *
   * This runs on its own the moment the server says the game is no longer live, which is
   * how both players end up back in the lobby without either of them having to ask. The
   * one thing it does not do is close the win overlay: a match that has just ended has a
   * result on it, that overlay sits above the lobby, and dismissing it is the click that
   * lands the player there. Slamming it shut would be a player never being told who won.
   */
  function leave() {
    clearPendingTimeout();
    if (state.app && state.app.controller) {
      state.app.controller.setLock(null);
      state.app.controller.setFireHandler(null);
    }
    state.payload = null;
    state.game = null;
    state.shots = [];
    state.messages = [];
    state.activeUserId = null;
    state.presence = { host: false, guest: false };
    state.pending = false;
    state.desynced = false;
    state.reported = false;
    state.lastVerdict = null;
    state.error = null;

    if (!boardIsOver()) hideModalIfOpen();
    show(state.els['match-panel'], false);
    show(state.els['modal-lobby-btn'], false);
    showError(state.els['chat-error'], null);
    if (state.screens && state.screens.openLobby) state.screens.openLobby();
    return null;
  }

  /** Whether the local board is the end of a match rather than the middle of one. */
  function boardIsOver() {
    return Boolean(state.app && state.app.game && state.app.game.world.state === 'over');
  }

  /** The overlay is shared with local play, so it is only closed if it is open. */
  function hideModalIfOpen() {
    var modal = state.doc ? state.doc.getElementById('modal') : null;
    if (modal && !modal.hidden && state.app && state.app.controller) {
      state.app.controller.closeModal();
    }
  }

  TE.match = {
    REQUIRED_IDS: REQUIRED_IDS,
    PRESENCE_LABELS: PRESENCE_LABELS,
    init: init,
    enter: enter,
    leave: leave,
    onEvent: onEvent,
    isActive: isActive,
    myTurn: myTurn,
    opponent: opponent,
    opponentPresent: opponentPresent,
    applyShot: applyShot,
    replay: replay,
    resync: resync,
    sendShot: sendShot,
    sendChat: sendChat,
    render: renderPanel,
    state: state
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
