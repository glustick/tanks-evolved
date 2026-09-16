# Tanks Evolved — Roadmap

Where the project has got to, and what is next. A phase is a release in its own
right: it is finished, verified and deployed before the next one starts.

## Shipped

### Phase 0 — the hot-seat duel

Two tanks on seed-derived destructible terrain, trade arcing shells affected by
gravity, wind and drag. Craters, blast and fall damage, per-turn wind, integrity
bars, win screen and rematch, procedural WebAudio. The simulation runs on a fixed
timestep from a seeded PRNG, so the same seed always produces the same match, and
`TE.game.stateHash()` fingerprints the whole world to prove it. Static site, no
build step, works from `file://`.

### Packaging — Docker and CI

An nginx image and compose file, GitHub Actions running the simulation, static and
browser suites, a container smoke test, and publication of both images to GHCR on
`main` or a `v*` tag. Deployed on Dockhand.

### Phase 1 — accounts, sessions and storage

The zero-dependency Node service: register, login, logout and `GET /api/me`, on
scrypt with the cost parameters stored per row, opaque cookie sessions where only
the token hash is persisted, no account enumeration on login, per-IP rate limits and
SQLite storage. Health endpoint, Dockerfile and a 20-check auth suite.

### Phase 2 — the lobby

An SSE stream, open games, host and join, a quick-match queue that pairs two waiting
players, and a server-issued seed when a game starts. Other players see a display
name and an id, never an email. Disconnects give up a queue place and cancel an open
game after a grace period, and an abandoned game is swept. On the client: register
and login screens, the lobby, and a connection chip. Local `file://` play is
untouched — `js/net.js` issues nothing at all unless the protocol is http(s).

### Phase 3 — the networked match

Two players on different machines, one game, turn by turn. The server **still never
simulates**: a shot is `(seed, playerIndex, angle, power)` and the simulation is
deterministic, so the server relays the aim and stores a fingerprint while both clients
run the same physics from the same seed. That one property is what makes the rest of the
phase cheap, and it is the shape everything below has.

- Turn relay. `POST /api/games/:id/shot` takes `{ angle, power, stateHash }`, stores it as
  the next entry in the game's replay log, relays it to both players and advances the turn.
- Turn ownership. The server derives whose turn it is from the shot count — the host plays
  odd turns — and refuses anything else with a 409. The client locks the board to match:
  aiming, firing, the seed box and the rematch keys all refuse while it is not your turn.
- `stateHash` agreement. Each shot carries the fingerprint of the board **as it was fired**,
  the opponent recomputes it before firing the same shot, and the receiver compares the two
  (js/match.js). When both players report a result, the server requires the same winner
  *and* the same final hash; a disagreement in either is recorded as a desync instead of a
  victory. The server does not compare hashes turn by turn — it cannot, it never simulates —
  so per-turn equality rests on the two clients checking each other, and the server's part
  is the comparison at the end. Making the hash authoritative server-side is a `Later` item.
- In-match text chat, stored and broadcast, trimmed and length-capped, rate-limited per
  player, and returned with the game so a reconnecting player sees what was said.
- A match can end. The winner is recorded, both players report it, and both are returned to
  the lobby — the lobby opens behind the result overlay, which is left on screen with the
  answer and a way back, so nobody is shown a lobby instead of a score. A finished game
  stops being a live one, so neither player is stranded in it.
- Presence. A player whose last stream closes is marked away and their opponent is told; if
  they do not come back within the abandonment window the match is a *walkover* for the
  player who stayed, which is what finally lets a game reach a terminal state without
  either client inventing one. Presence is the event stream, so a player with no stream at
  all is not tracked as away — the client always opens one.
- Reconnect, and recovery. A reload mid-match refetches the game and replays the seed plus
  the ordered shot log through the same simulation, arriving at the board the other player
  is on. The same path — fetch the match, replay the log — is what a client falls back on
  when it has reason to think it is behind: a shot whose answer never came back, or a
  stream that dropped between two turns. The aim being lined up is carried across that
  rebuild, because it is the one piece of the board that is in no log and belongs to
  neither the server nor the opponent.
- "Load this map locally" is gone: it existed only because there was no relay.
- Verified by `server/test/match.test.js`, whose last check drives the real simulation in
  Node for two players — including js/match.js itself — through a complete match over HTTP,
  asserting identical `stateHash` after every turn, agreement with the stored value, an
  accepted winner, and a third "reconnecting" client that rebuilds the same final hash from
  the seed and the shot log alone. The client's half was driven in two real browsers (two
  profiles against a running server) for a whole match, a mid-match reload, and a board
  deliberately knocked out of step; that harness was temporary and is not in the repository.

## Next

### Hardening before this faces the internet

Every item below is known rather than hypothetical, and is recorded here so it is not
rediscovered later. All of it must be closed before the service is reachable from
outside the network.

| # | Issue | Why it matters |
| - | ----- | -------------- |
| 1 | Rate limits ignore `X-Forwarded-For` | Behind a reverse proxy every player shares one bucket, so one client can lock out logins, registration, hosting and queueing for everyone. It is also the only bound on row creation. |
| 2 | No TLS, and `Secure` cookies are opt-in | Session cookies travel in clear over plain HTTP. |
| 3 | The queue, every stream, and both pending result reports live in process memory | Single replica only. A restart drops queue places and a half-finished result, and a second instance would show a different queue and refuse to finish a match the two players had already agreed on. |
| 4 | No email verification, no password reset | Nothing proves an address, and a locked-out player has no way back in. |
| 5 | Display names are not unique | Two accounts can look identical in the lobby list. |
| 6 | No cap on total games per account | A player who never returns leaves rows behind for up to the abandonment window. A finished game is kept forever, with its shots and chat. |
| 7 | CSRF rests on `SameSite=Lax` alone | Sound while every state change is a POST on one origin — and lost the moment the API moves to another host or a state-changing `GET` appears. |

## Later

Ideas that are not scheduled. Ordered roughly by how much they would add.

### Tank movement, with action points each turn

Requested. Give each tank a budget of action points every turn and let the player spend
them driving forward or backward across the terrain, then aim and fire with what is left
of the turn.

*Why it matters:* the tanks are static, so a bad position is permanent and a match comes
down to aim alone. Being able to reposition — to climb out of a crater, to drop behind a
ridge, to close or open the range — is the missing half of the tactics, and it is what
would make the destructible terrain matter to movement and not only to damage.

**The part to get right first is the relay.** The whole netcode rests on a turn being a
small set of numbers both machines can replay, and today that set is
`(seed, playerIndex, angle, power)`: `js/game.js` fires from it, the shot row in
`server/lib/db.js` stores it, and `POST /api/games/:id/shot` carries it. Movement makes
that `(…, move)` — and `move` has to travel the same path and land in the same row. If a
client moves without telling the server, the two boards diverge and the match is reported
as a desync that neither player caused; storing it in the log is also what keeps reconnect
working, since rebuilding from a reload is a replay of that log.

Movement should go through the existing simulation rather than being applied as a
teleport. The tank state already models ground support, falling and fall damage, and
`js/tanks.js` says so in its header — "tanks are static in Phase 0: no driving, no fuel,
they do fall when a shell removes the ground beneath them". Driving off a ledge should
drop the tank and cost it integrity, exactly as a crater edge does now, so "the ground
under a tank changed" stays one code path instead of two.

Reverses a Phase 0 decision: tank movement was listed as deliberately out of scope, in
`js/tanks.js` and in the README's Phase 0 scope.

Worth deciding when it is picked up: whether the move is spent before aiming as one
combined action or as its own step, whether the opponent sees the move as it happens or
only the resulting board, and whether a tank can be driven somewhere it cannot shoot from.

### Weapon pickups, dropped across the battlefield

Requested. Seed the map with weapon crates that a tank drives over to collect, replacing
whatever it is firing — rockets, lasers, grenades, mortars — dropped at random but
**evenly**, so the layout does not hand one player the match.

**This depends on tank movement** (the entry above). "Run over" needs a tank that can
drive. Without it a pickup is only reachable by the accident of a shell landing on one, or
by spawning underneath a tank, which is not the feature.

**Fairness here is a layout problem, not a quantity problem.** The natural approach mirrors
the drops about the map centre, so whatever sits on the left has an equal on the right and
neither player starts closer to an advantage — the player spawns are already symmetric in
spirit, 1234 units apart on the default seed. Mirroring positions is not sufficient by
itself, though: a laser and a mortar are not equally strong, so equal-by-position still
leaves whoever draws the better weapon ahead. Two ways out, and one should be chosen
deliberately:

- mirror the *type* too, so both sides get the same options and the match turns on who
  uses them better — the most even, and the least varied;
- or pair by tier, so each side gets one strong and one weak pickup at mirrored positions.

Either way a pickup should be a limited resource — a few shots, or one — so collecting one
opens a window rather than deciding the match.

**Determinism.** Drops must come from the match seed like everything else, through a
**new named stream** alongside the existing `terrain`, `spawn`, `wind` and `ridge`
(`js/utils.js`). A new name is safe; drawing from an existing stream would shift that
stream's output for every seed, invalidating the tuning table in the README and every
stored replay. The weapon a tank is holding has to join `TE.game.stateHash()` next to its
integrity, angle and power — otherwise two clients can hold different weapons and the hash
will not notice, which is precisely the class of bug the hash exists to catch — and the
drop layout wants a checksum there for the same reason the terrain has one.

**Terrain.** A pickup rests on the surface, and the surface moves: a shell that blows the
ground out from under one should drop it and settle it again. That is the falling and
settling path the tanks already use, and this would be the third feature to want it.

- Server-side simulation in a worker thread, so the state hash is authoritative
  rather than merely cross-checked — and so a desync can be resolved rather than only
  detected. The simulation core already loads headlessly in Node, so this is wiring
  rather than new physics.
- Match end conditions beyond last-tank-standing, and a match history drawn from the
  finished games and their replay logs that the database now keeps.
- An AI opponent, and a practice mode against it.
- Spectating, and chat in the lobby rather than only inside a match.
- Rematch from the win screen against the same opponent.
- Account management: change display name, change password, delete account.
- Weather — the last system Phase 0 deliberately left out, and the only one of the
  three still without a request behind it. (Weapons now have their own entry above.)
- Ranked play.

## Deliberately out of scope

- A build step for the client. It is plain files with plain globals, and it stays
  that way.
- Third-party dependencies on the server. `node:` builtins only — no `package.json`.
- Anything that breaks local hot-seat, or the ability to open `index.html` from disk.
