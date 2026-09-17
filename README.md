# Tanks Evolved

A modernised turn-based artillery duel in the spirit of *Artillery Duel* / *Scorched
Earth*: two tanks trade arcing, wind-affected shells across a destructible
landscape.

The game is still a no-build static site that works from `file://` and plays local
hot-seat. Alongside it, `server/` holds the account service, the lobby, and the relay two
players on different machines play a match through — see [Server](#server).

```
open tanks-evolved/index.html          # works straight from disk (file://)
node server/index.js                   # or online: accounts, the lobby, networked matches
python3 -m http.server -d tanks-evolved 8000   # or any static host
```

Opening the page from disk is unchanged: no server is looked for, nothing is requested,
and the game goes straight to local hot-seat. Served over HTTP, the page finds the API on
its own origin: signed out it offers an account, signed in it shows the lobby, and a
match puts both players on the same board.

See [ROADMAP.md](ROADMAP.md) for what has shipped and what is next.

## Phase 0 scope

In: two static tanks on seed-derived terrain, turn-based aiming, gravity + wind +
drag ballistics, heightfield craters, blast falloff damage and fall damage,
integrity bars, per-turn wind, seeded PRNG, win screen + rematch, WebAudio SFX and
ambience, a modern dark HUD.

Out (deliberately, for Phase 0): server, matchmaking, chat, accounts, AI opponent,
weather, multiple weapons, tank movement.

## Lobby scope (Phase 2)

In: accounts with a display name, hosting a game, joining one, cancelling one, a
quick-match queue, a live lobby pushed over Server-Sent Events, and the sign-in and
lobby screens that reach all of it.

Out (Phase 3): playing the networked match, which is the next section.

## Match scope (Phase 3)

In: a game that is `playing` becomes a real match between the two players. Your turn aims
and fires through the server; their turn locks the board and says who you are waiting
for. The opponent's shot is applied through the same simulation, so both boards stay
identical, and each one fingerprints what it has after every turn. In-match chat.
Presence — connected or away — and a walkover if the other player never comes back. A
match ends with a recorded winner, and both players return to the lobby. Reload the page
mid-match and you rejoin it: the seed and the shot log *are* the board, so catching up is
replaying them.

What the server does **not** do is simulate. A shot is `(angle, power, stateHash)`: it is
relayed, stored in the game's replay log and compared at the end. The two clients are the
only things that know what the world looks like, and both of them report the result before
it is accepted.

Local hot-seat is unchanged. From `file://` nothing is requested, and the board, the seed
box and the rematch keys work exactly as they always did.

## Controls

| Action | Keys | Other |
| --- | --- | --- |
| Angle | `W` / `S` or `↑` / `↓` | Angle slider, drag on the battlefield |
| Power | `A` / `D` or `←` / `→` | Power slider, drag on the battlefield |
| Fine adjust | hold `Shift` with any aim key | — |
| Fire | `Space` | **Fire** button |
| Rematch (same seed) | `R` | Win screen → **Rematch** |
| New map (new seed) | `N` | Seed chip → **New map** |
| Mute | `M` | **Sound on/off** |
| Set an exact seed | — | Type in the Seed box, press `Enter` or **Set** |
| Chat (in a networked match) | — | The chat field in the match panel |

The seed is always visible in the top bar and is the only source of randomness:
same seed → same terrain, same tank placement, same wind sequence.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup for the canvas + HUD, the sign-in and lobby screens, script tags in dependency order, 15-line bootstrap. |
| `css/style.css` | Dark "ops console" UI: layout, chips, sliders, integrity bars, win overlay, lobby screens. |
| `js/version.js` | `RELEASE_VERSION` / `BUILD_NUMBER` and the `v0.1.0+b1` label shown in the HUD. |
| `js/utils.js` | World constants, math helpers, mulberry32 PRNG, named seed streams, wind roll. |
| `js/terrain.js` | Seed-derived heightfield generation, surface queries, crater destruction. |
| `js/physics.js` | Shell integration (gravity, wind, drag) and swept terrain/tank/out-of-bounds collision. |
| `js/tanks.js` | Tank state: position, tilt, integrity, aim, muzzle geometry, falling + fall damage. |
| `js/render.js` | Canvas drawing, shell-following camera, particle FX, in-canvas HUD. |
| `js/input.js` | Keyboard + sliders + canvas-drag aiming, fire, seed/rematch/mute wiring, DOM HUD updates. |
| `js/game.js` | Match/turn state machine, craters + damage, wind per turn, win/rematch, app bootstrap. |
| `js/audio.js` | Procedural WebAudio SFX (fire, explosion, armour hit, fanfare) and the ambient bed. |
| `js/net.js` | The server from the browser: the `/api` calls over fetch, the SSE stream over EventSource, and the file:// guard that makes both opt-in. |
| `js/screens.js` | The register / login and lobby screens, and the connection indicator — DOM only, no requests of its own. Hands a `playing` game to `js/match.js` and takes the board back when the match is over. |
| `js/match.js` | The networked match: the turn lock, the shot relay, the replay that rebuilds a board from the seed and the shot log, the chat panel and the result. |
| `js/selftest.js` | In-page assertion suite, run by opening `index.html#selftest`. |
| `tools/check-determinism.js` | Node+`vm` determinism suite over the simulation core. |
| `tools/check-static.js` | Static constraint checks (assets exist, no modules, no external URLs, same-origin requests, DOM id contract, load order). |
| `tools/headless-check.sh` | Loads the page in headless Chrome twice and fails on console errors. |
| `tools/check-ui.js` | End-to-end UI test over the DevTools protocol: real clicks, drags, win screen, rematch. |
| `Dockerfile` | Single-stage `nginx:1.30-alpine` image: these static files, an unprivileged port, no build step. |
| `nginx.conf` | MIME types, cache headers, gzip and the `try_files` fallback — the whole server config. |
| `docker-compose.yml` | Local run on `:8080`, with a read-only root filesystem and tmpfs for nginx's writable paths. |
| `.dockerignore` | Keeps `tools/`, `README.md` and the git history out of the build context and the image. |
| `server/index.js` | Server entry point: env → database → listen, plus signal and crash handling. |
| `server/lib/` | The service itself: routing, static serving, scrypt passwords, cookie sessions, rate limiting, SQLite storage, and the realtime hub — the lobby, the match relay and presence (`lobby.js`). |
| `server/test/auth.test.js` | 20-check auth suite over real HTTP against a spawned server, no dependencies. |
| `server/test/lobby.test.js` | 21-check lobby suite: hosting, joining, the queue, the event stream, disconnect cleanup, rate limits, stream bounds. |
| `server/test/match.test.js` | 16-check match suite: the shot relay, turn ownership, the replay log, chat, results and desyncs, rate limits and the walkover — plus a complete two-player match driven through the API by the real simulation. |
| `server/Dockerfile` | `node:24-alpine`, unprivileged, healthchecked. Built from the repository root. |
| `.github/workflows/ci.yml` | CI: the Node suites, the browser checks, the container smoke test, and image publication. |

## Server

`server/` is the account service, the lobby and the match relay: a zero-dependency Node 24
program using only `node:http`, `node:crypto` and `node:sqlite` — no `package.json`, no
`node_modules`. It serves the client and the API from one origin, which is what keeps CORS
and cross-site cookies out of the design entirely.

It does not simulate. A match is relayed shot by shot and cross-checked by fingerprint; the
two browsers run the physics. See [The networked match](#the-networked-match).

```bash
node server/index.js                              # http://127.0.0.1:8081
PORT=9000 TANKS_DB=/tmp/t.db node server/index.js # or point it somewhere else
```

| Endpoint | |
| --- | --- |
| `GET /api/health` | `{ ok, version }` — the container healthcheck target, no auth |
| `POST /api/auth/register` | `{ email, password }` → session cookie |
| `POST /api/auth/login` | `{ email, password }` → session cookie |
| `POST /api/auth/logout` | ends the session |
| `GET /api/me` | the current user, or 401 |
| `GET /api/lobby` | open games, the queue depth, and your own state (`you.player`, `you.waiting`, `you.game`) |
| `POST /api/games` | host a game (409 if you are already hosting one) |
| `POST /api/games/:id/join` | join an open game: it becomes `playing` with a **server-issued seed**, and both players are notified |
| `DELETE /api/games/:id` | the host cancels an open game |
| `GET /api/games/:id` | the whole match for its two players only: the game, the ordered `shots`, the `messages`, the `turn`, whose turn it is, and who is present (403 for anyone else) |
| `POST /api/games/:id/shot` | `{ angle, power, stateHash }` → the next entry in the replay log, relayed to both players. Only the player whose turn it is, and only once per turn |
| `POST /api/games/:id/chat` | `{ text }` → stored and broadcast; trimmed, capped at 500 characters, rate-limited per player |
| `POST /api/games/:id/result` | `{ winnerUserId, stateHash }` → recorded; **both** players must report the same winner and the same board before the match is finished |
| `POST /api/queue` | enter the quick-match queue, pairing immediately if somebody is waiting |
| `DELETE /api/queue` | leave the queue |
| `GET /api/stream` | Server-Sent Events: `hello` on connect, then `lobby`, `queue`, `match`, `game`, `shot`, `chat`, `turn`, `over`, `desync`, `opponent` |

Anything else under `/api/` is a JSON 404, or a 405 with `Allow` for a known path with the
wrong method. Every other path serves the client under the same rules as `nginx.conf`.

Passwords use scrypt with the cost parameters stored per row, so the work factor can be
raised later without invalidating existing hashes. Sessions are opaque 32-byte tokens in
an `HttpOnly`, `SameSite=Lax` cookie, and only `sha256(token)` is stored — a copy of the
sessions table is not a set of usable credentials. An unknown email spends the same scrypt
work as a real verification, so login cannot be used to discover which addresses are
registered. The auth endpoints are rate-limited per IP, and so are hosting a game and
queueing for one (separate buckets, so one cannot lock out another).

A player is identified to everyone else by `displayName` and an id, nothing more. The
display name defaults to the local part of the address and is the only thing about an
account that leaves the server: no response about another player contains their email
address, and `server/test/lobby.test.js` asserts that over every response and every stream
event the suite produces.

### The event stream

`GET /api/stream` is authenticated by the session cookie and gives each connected user
their own stream — several tabs are several streams, and all of them update. Ten event
names, each carrying a JSON body:

| Event | Carries |
| --- | --- |
| `hello` | on connect: the same shape as `lobby` |
| `lobby` | whenever the open games or the queue depth change |
| `queue` | your own queue state |
| `match` | a game you have been put into — the whole match, as below |
| `game` | the whole match again, after anything about it changed |
| `shot` | a shot to apply: `{ turn, userId, angle, power, stateHash }` |
| `chat` | one message |
| `turn` | whose turn it now is |
| `over` | the match finished, with the winner and why (a report, or a walkover) |
| `desync` | it finished without one, because the two clients disagreed |
| `opponent` | the other player disconnected or came back |

A comment line every `TANKS_STREAM_KEEPALIVE_MS` keeps idle proxies from closing a quiet
stream.

The cleanup story, because a dropped connection must not strand anyone:

| State | What happens when a player's last stream closes |
| --- | --- |
| Queue entry | removed, after a `TANKS_STREAM_GRACE_MS` grace period so a reconnect (which EventSource does by itself) keeps their place |
| Open game they host | cancelled, for the same reason: an open game means "I am here, waiting for an opponent" |
| A game already `playing` | left alone — a refresh or a tunnel must not concede a match. The player is marked **away** and their opponent is told; if they have not come back after `TANKS_ABANDON_MS` the match is awarded to the player who stayed |

A match both players walked away from is swept after the same window, which is the last
resort for a row that would otherwise block whichever of them comes back. Streams, the
queue and the two pending result reports are in memory, so a restart clears them and every
waiting client learns from its own reconnecting stream; games, shots and chat are rows,
because they have to outlive the tab that made them.

### The networked match

The server relays shots and compares fingerprints; it never simulates. A shot is
`(seed, playerIndex, angle, power)`, the simulation is deterministic, so both machines
already produce byte-identical results from the same inputs — the server's job is to be
the shared log and the referee.

```
A aims ──POST shot {angle, power, stateHash}──▶ server stores turn N
                                                ├─▶ A: shot event ─┐
                                                └─▶ B: shot event ─┤ both apply it with the
                                                                   │ same code, from the
                                                                   ▼ same seed
   both boards, fingerprints equal ────────▶ turn N+1, whose turn comes from the shot count
```

| Question | Where the answer comes from |
| --- | --- |
| Whose turn is it? | the server: `turn = shots.length + 1`, and the host plays odd turns. A shot from anyone else is a 409 |
| Has this turn been played? | a UNIQUE index on `(game_id, turn)` in storage, behind a turn check that refuses it first |
| Are the two boards the same? | each shot carries the hash of the board **as it was fired**; the opponent recomputes it before firing the same shot and compares, and both players report the final hash with the result — a disagreement in the winner *or* the board is recorded as a desync, not a victory |
| Who won? | the two clients, and only if they agree. The server cannot check a result, so it requires both reports rather than taking one |
| What happens if a client misses a shot? | it fetches the match again — one payload, the seed and the ordered log — and replays it. The same path as a reload, which is the same path as joining |

Because the log *is* the board, a reconnecting client needs no snapshot: rejoin, resync
after a dropped stream, and a fresh player all replay the same shots from the same seed
through the same `TE.match.applyShot()`.

### Environment

| Variable | Default | |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8081` | `PORT=0` binds any free port (the suites rely on it) |
| `TANKS_DB` | `server/data/tanks.db` | relative to the repository root |
| `TANKS_SECURE_COOKIES` | `0` | set to `1` behind HTTPS |
| `TANKS_SESSION_TTL_MS` | 30 days | |
| `TANKS_BODY_LIMIT_BYTES` | 8192 | |
| `TANKS_TIMEOUT_MS` | 30 s | request timeout |
| `TANKS_LOGIN_MAX` / `_WINDOW_MS` | 10 per 5 min | per client IP |
| `TANKS_REGISTER_MAX` / `_WINDOW_MS` | 5 per 60 min | |
| `TANKS_GAMES_MAX` / `_WINDOW_MS` | 20 per 10 min | |
| `TANKS_QUEUE_MAX` / `_WINDOW_MS` | 30 per 5 min | |
| `TANKS_SHOTS_MAX` / `_WINDOW_MS` | 120 per 5 min | per **player**, not per address: this bounds one player flooding a match, and a shared connection must not make two players share a budget |
| `TANKS_CHAT_MAX` / `_WINDOW_MS` | 60 per 1 min | per player |
| `TANKS_STREAM_KEEPALIVE_MS` | 20 s | SSE comment interval |
| `TANKS_STREAM_GRACE_MS` | 15 s | reconnect window before cleanup |
| `TANKS_ABANDON_MS` | 30 min | how long a match survives with nobody connected, before it is a walkover |
| `TANKS_SWEEP_MS` | 60 s | how often that is looked for |
| `TANKS_MAX_STREAMS_PER_USER` | 8 | live event streams one account may hold — exceeding it is a JSON 503 rather than a dropped connection |

**Not yet:** email verification, password reset, TLS termination, honouring
`X-Forwarded-For`, and match history (finished games and their logs are kept, but nothing
reads them back). The per-IP limit currently treats every request arriving through a
reverse proxy as one client, so that needs fixing before this is exposed publicly — see
[Notes and known limits](#notes-and-known-limits).

```bash
node server/test/auth.test.js     # 20 checks over real HTTP, no dependencies
node server/test/lobby.test.js    # 21 checks: the lobby, the queue and the stream
node server/test/match.test.js    # 16 checks: the relay, chat, results, presence — and a whole match
```

## Determinism

Every random value comes from a mulberry32 stream derived from the seed
(`version`, `terrain`, `spawn`, `wind`, `scenery`), so subsystems cannot
accidentally share a sequence. `Math.random()` is never called — `tools/check-static.js`
and `tools/check-determinism.js` both fail if it appears. Drawing a *new* number of values
out of an existing stream is what the rule protects: it would shift that stream's output
for every seed, and with it the battlefield, the tuning table and every stored replay. So
a new subsystem gets a new name — the post-apocalyptic scenery, which replaced the old
`ridge` parallax layers, draws from `scenery` and is read by nothing else.

The match advances on a fixed timestep (`1/120 s`, `4` collision substeps) with an
accumulator, so the outcome does not depend on frame rate or on how long a tab was
hidden. Visual effects use their own seeded stream and frame time; they never feed
back into game state.

`TE.game.stateHash(game)` fingerprints terrain, wind, turn, both tanks and the
shell, and is what the browser self-test compares across two runs — and what the two
clients in a networked match compare after every turn, with the server storing each turn's
value in the replay log so a replay can check itself rather than only agreeing at the end.

## Verification

All three commands are self-contained (no install step, no dependencies).

**1. Simulation core, in Node (9 checks + a range report)**

```bash
node tools/check-determinism.js
```

Expected tail:

```
PASS  8. craters are deterministic, dig-only, bounded and slope-limited
      dug 1245.3 units, max depth 34.1 (cap 34.1), steepest column step 2.650 (limit 2.90), second hit dug 1245.3
PASS  9. no Math.random() in js/
      5 files scanned, 0 occurrences
...
9/9 checks passed
```

**2. Static constraints (7 checks)**

```bash
node tools/check-static.js
```

Three of those seven changed in Phase 2, because the client now talks to a server:

- **Kept:** every referenced asset exists, every js file parses, no ES modules, no
  dynamic script loading, the DOM id contract (now for `input.js` *and* `screens.js`),
  the script load order, and no external URLs — which now means "nothing that leaves the
  origin", so an absolute `http(s)` target or a CDN reference is still rejected.
- **Dropped:** the blanket ban on `fetch`/`XHR`, which was the right way to say
  "file://-only" before there was a server and became wrong the moment there was one.
- **Added:** every request the client makes must be a relative, same-origin path. A
  literal target has to start with a single `/`; a non-literal one has to be a name from
  `js/net.js`'s own path table, and every path-shaped string in the client is checked too.
  The file:// guarantee these used to carry is now enforced in the code instead: `net.js`
  asks `location.protocol` before it asks for anything, so a page opened from disk issues
  no request at all.

**3. Real browser load + in-page assertions**

```bash
tools/headless-check.sh          # uses Chrome/Chromium; CHROME=... to override
node tools/check-ui.js           # optional: --shots <dir> to dump screenshots
```

`headless-check.sh` runs `index.html` (animation loop live) and
`index.html#selftest` (17 in-page checks: module load, canvas, DOM id contract,
terrain/match determinism, crater and damage rules, wind re-roll, keyboard
routing, a scripted match played to a win, rematch reset, 240 rendered frames,
seed sanitising, and zero uncaught errors). Expected:

```
RESULT: PASS
```

`check-ui.js` drives the real UI over the DevTools protocol (Node 22+, no
dependencies) and checks that clicking **Fire** launches a shell, that the shell
lands and carves terrain, that dragging on the battlefield rewrites the aim,
that the sliders and seed field are wired to the model, that the win overlay
opens at 0 integrity and **Rematch** resets the board, and that no console error
occurs during the session. Add `--shots <dir>` to also write
`mid-flight.png`, `win-modal.png` and `after-impact.png` for eyeballing.

The self-test also prints its full report to the browser console and sets the page
title to `SELFTEST PASS` / `SELFTEST FAIL`, so it can be run by hand in any browser.

**4. A networked match, in the browser**

`tools/check-ui.js` drives `file://`, deliberately: local hot-seat is the mode that must
never break, and the browser checks are what prove it does not — including that the board
is *not* locked, which is the one thing the match could have broken.

The networked path is verified with two real browser profiles against a running server,
and the phase's report describes what was seen rather than wiring a two-browser harness
into CI: register on both, host and join, play a match to a win with the same aim solver
the suite uses, then reload one tab mid-match and watch it replay its way back into the
same board. Every turn's `TE.game.stateHash()` is compared across the two browsers.

```bash
node server/index.js                              # then open it in two profiles
# and in a third profile, as a spectator: GET /api/games/:id is a 403
```

That harness is deliberately not in the repository: it needs two Chrome profiles and a
browser that is not the runner's, and the phase's real acceptance evidence is
`server/test/match.test.js`, which drives the same journey through the API without a
browser in the way.

## Docker

The site is static, so the image is just `nginx:1.30-alpine` with this directory copied
into its document root. No build stage and no Node in the image — the visitor's browser
is what runs the JS.

```bash
docker build -t tanks-evolved .
docker run --rm -p 8080:8080 tanks-evolved      # → http://localhost:8080
```

Or with compose, which builds the same image and adds a read-only root filesystem:

```bash
docker compose up --build                       # → http://localhost:8080
```

| Detail | Value |
| --- | --- |
| Port in the container | `8080`, unprivileged — the image runs as the `nginx` user |
| Host port | `-p <any>:8080` with `docker run`; compose publishes `8080` |
| `index.html` | `Cache-Control: no-cache` — revalidated, so a deploy is picked up |
| `css/`, `js/` | `Cache-Control: public, max-age=3600`, for the reason in `nginx.conf` |
| Unknown paths | served the game shell via `try_files`, not a bare 404 |

`tools/` and `README.md` are left out of the image deliberately: nothing at runtime
reads them, and the document root is served over HTTP, so copying `tools/` would publish
the test harness at the same URLs as the game.

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, on every pull request, and on
`workflow_dispatch`. Five jobs, nothing installed in any of them:

| Job | Node | What it runs |
| --- | --- | --- |
| `suite` | `22` and `24` | `node tools/check-determinism.js`, then `node tools/check-static.js` |
| `browser` | `22` | `tools/headless-check.sh`, then `node tools/check-ui.js`, against the runner's Chrome |
| `docker` | — | `docker build`, then `curl` the running container for real game markup |
| `server` | `24` | `node server/test/auth.test.js`, then `node server/test/lobby.test.js`, then `node server/test/match.test.js` |
| `publish` | — | Builds and pushes both images — **only** on `main` or a `v*` tag, and only after every check above has passed |

The browser job resolves `google-chrome`/`chromium` on the runner and passes the path
through `CHROME`. Both tools exit `2` when they cannot find a browser, and CI turns that
exit code into a failed step rather than a skip: a "browser" job that never started a
browser is not evidence of anything.

The publish job tags the image `latest`, `sha-<short>` and the `RELEASE_VERSION` from
`js/version.js`, plus the git tag itself on a `v*` push, and authenticates with the
run-scoped `GITHUB_TOKEN` — no long-lived registry secret. GHCR creates a new package
**private**; the first time it publishes, set the package to public once in the repo's
package settings, and every later push stays public.

## Tuning

All gameplay numbers live in `TE.CONST` (`js/utils.js`). Current calibration,
measured by the range report in `tools/check-determinism.js` (muzzle 30 units above
flat ground, no wind):

| Angle | Power | Range | Flight |
| --- | --- | --- | --- |
| 45° | 100 | ~1557 | 2.59 s |
| 45° | 80 | ~1025 | 2.10 s |
| 60° | 100 | ~1312 | 3.13 s |
| 30° | 100 | ~1410 | 1.87 s |

Tanks usually spawn 900–1400 units apart, so a cross-map shot needs 80–100% power.
A shell removes a crater up to 34 units deep and 62 units wide; a direct hit costs
52.5 integrity, a point-blank splash 42, and damage falls to zero at 66 units.

## Notes and known limits

- Rendering is verified by headless screenshots (aiming, mid-flight, explosion,
  win screen) plus the self-test driving 240 frames and the UI test's drag/click
  session. Explosion particles were inspected at 0 and +30 frames.
- Audio is only started from a real click or keypress (browser autoplay policy), so
  the page is silent until the first interaction; a headless run is silent by design.
- The camera frames both tanks while aiming and follows the shell while it flies.
  Below `0.45x` the view is clamped, and the ground is drawn continuing past both
  map ends so a zoomed-out view never shows a void.
- One shell type, no tank movement, no AI — by design for Phase 0.
- **Running the client without the server is supported, and looks like it always did.**
  From `file://` nothing is requested at all; on a static host the API answers HTML (or
  404) and the client treats that as "no lobby here" rather than as a session. In both
  cases the board, the seed box and local hot-seat work exactly as before, and the
  status chip reads `OFFLINE` instead of `LIVE`.
- **A networked match is only as live as its event stream.** Presence, the turn, the
  relayed shots and the chat all arrive on the stream; a client whose stream is down
  stops hearing about the match and only catches up when it reconnects (which EventSource
  does by itself, and which triggers a refetch-and-replay). A player who never opened a
  stream is not tracked as present or away at all — the client always opens one, so this
  is a limit of the protocol rather than something a player can hit.
- **The two boards are only guaranteed identical between turns.** A shell in flight is at
  a slightly different frame on each machine, and `TE.game.stateHash()` includes the
  shell, so the fingerprints differ mid-flight by design. Every comparison — the relayed
  shot's own hash, the result both players report — is taken at a turn boundary.
- **Before this is exposed to the public internet**, four things need attention:
  1. **Rate limiting is per socket address and does not read `X-Forwarded-For`.** Behind a
     reverse proxy every player shares one bucket, so one client can lock out everybody
     else; without a proxy it is fine, and it is also the only thing standing between an
     anonymous client and unlimited rows in `games`. It needs a trusted-proxy
     configuration, not just an enabled header. (Shots and chat are limited per player
     instead, so the match itself is already keyed correctly.)
  2. **There is no TLS and no `Secure` cookie by default.** `TANKS_SECURE_COOKIES=1` is
     required behind HTTPS, and HTTP must not be exposed.
  3. **Nothing bounds the number of accounts or games beyond the rate limits.** A single
     address can register 5 accounts an hour and host 20 games per 10 minutes, forever. A
     finished game — its row, its shots and its chat — is kept indefinitely.
  4. **No email verification and no password reset**, so an address is never proven and a
     forgetful player is stuck. Accounts are also unauthenticated chaos-wise: a display
     name is not unique, so two players can look identical in the lobby list.
- The queue, the event streams and the two pending result reports live in process memory,
  so this runs as **one replica**: a second instance would have a queue nobody else can see
  and would refuse to finish a match the two players had already agreed on. Horizontal
  scaling needs a shared store (and sticky sessions for the streams) before it needs
  anything else.
