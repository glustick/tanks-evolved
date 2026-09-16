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

## Next

### Phase 3 — the networked match

The part that makes it multiplayer, and the only phase where two people play each
other rather than their own board.

- [ ] Turn relay. The active player's `(angle, power)` goes to the server and out to
      the opponent, so both machines simulate the same shot from the same seed.
- [ ] `stateHash` agreement after each turn. The server compares both clients' hashes
      and flags a desync, instead of letting two boards quietly diverge.
- [ ] Turn ownership. Aiming is locked when it is not your turn.
- [ ] In-game text chat between the two players.
- [ ] A match can end: the winner is recorded and both clients return to the lobby.
- [ ] Reconnect. Reload the page mid-match and rejoin the game in progress.
- [ ] Retire "Load this map locally", which exists only because there is no relay yet.

## Hardening before this faces the internet

Every item below is known rather than hypothetical, and is recorded here so it is not
rediscovered later. All of it must be closed before the service is reachable from
outside the network.

| # | Issue | Why it matters |
| - | ----- | -------------- |
| 1 | Rate limits ignore `X-Forwarded-For` | Behind a reverse proxy every player shares one bucket, so one client can lock out logins, registration, hosting and queueing for everyone. It is also the only bound on row creation. |
| 2 | No TLS, and `Secure` cookies are opt-in | Session cookies travel in clear over plain HTTP. |
| 3 | The queue and every stream live in process memory | Single replica only. A restart drops queue places, and a second instance would show a different queue. |
| 4 | No email verification, no password reset | Nothing proves an address, and a locked-out player has no way back in. |
| 5 | Display names are not unique | Two accounts can look identical in the lobby list. |
| 6 | No cap on total games per account | A player who never returns leaves rows behind for up to the abandonment window. |
| 7 | CSRF rests on `SameSite=Lax` alone | Sound while every state change is a POST on one origin — and lost the moment the API moves to another host or a state-changing `GET` appears. |

## Later

Ideas that are not scheduled. Ordered roughly by how much they would add.

- Server-side simulation in a worker thread, so the state hash is authoritative
  rather than merely cross-checked. The simulation core already loads headlessly in
  Node, so this is wiring rather than new physics.
- Match end conditions beyond last-tank-standing, and a match history.
- An AI opponent, and a practice mode against it.
- Spectating, and chat in the lobby rather than only inside a match.
- Rematch from the win screen against the same opponent.
- Account management: change display name, change password, delete account.
- Additional weapons, tank movement and weather — the systems Phase 0 deliberately
  left out once there is a reason and an audience for them.
- Ranked play.

## Deliberately out of scope

- A build step for the client. It is plain files with plain globals, and it stays
  that way.
- Third-party dependencies on the server. `node:` builtins only — no `package.json`.
- Anything that breaks local hot-seat, or the ability to open `index.html` from disk.
