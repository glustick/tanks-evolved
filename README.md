# Tanks Evolved — Phase 0

A modernised turn-based artillery duel in the spirit of *Artillery Duel* / *Scorched
Earth*: two tanks trade arcing, wind-affected shells across a destructible
landscape. Local hot-seat only — no server, no accounts, no networking, no build
step.

```
open tanks-evolved/index.html          # works straight from disk (file://)
python3 -m http.server -d tanks-evolved 8000   # or any static host
```

## Phase 0 scope

In: two static tanks on seed-derived terrain, turn-based aiming, gravity + wind +
drag ballistics, heightfield craters, blast falloff damage and fall damage,
integrity bars, per-turn wind, seeded PRNG, win screen + rematch, WebAudio SFX and
ambience, a modern dark HUD.

Out (deliberately, for Phase 0): server, matchmaking, chat, accounts, AI opponent,
weather, multiple weapons, tank movement.

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

The seed is always visible in the top bar and is the only source of randomness:
same seed → same terrain, same tank placement, same wind sequence.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup for the canvas + HUD, script tags in dependency order, 10-line bootstrap. |
| `css/style.css` | Dark "ops console" UI: layout, chips, sliders, integrity bars, win overlay. |
| `js/version.js` | `RELEASE_VERSION` / `BUILD_NUMBER` and the `v0.1.0+b1` label shown in the HUD. |
| `js/utils.js` | World constants, math helpers, mulberry32 PRNG, named seed streams, wind roll. |
| `js/terrain.js` | Seed-derived heightfield generation, surface queries, crater destruction. |
| `js/physics.js` | Shell integration (gravity, wind, drag) and swept terrain/tank/out-of-bounds collision. |
| `js/tanks.js` | Tank state: position, tilt, integrity, aim, muzzle geometry, falling + fall damage. |
| `js/render.js` | Canvas drawing, shell-following camera, particle FX, in-canvas HUD. |
| `js/input.js` | Keyboard + sliders + canvas-drag aiming, fire, seed/rematch/mute wiring, DOM HUD updates. |
| `js/game.js` | Match/turn state machine, craters + damage, wind per turn, win/rematch, app bootstrap. |
| `js/audio.js` | Procedural WebAudio SFX (fire, explosion, armour hit, fanfare) and the ambient bed. |
| `js/selftest.js` | In-page assertion suite, run by opening `index.html#selftest`. |
| `tools/check-determinism.js` | Node+`vm` determinism suite over the simulation core. |
| `tools/check-static.js` | Static constraint checks (assets exist, no modules/fetch/CDN, DOM id contract). |
| `tools/headless-check.sh` | Loads the page in headless Chrome twice and fails on console errors. |
| `tools/check-ui.js` | End-to-end UI test over the DevTools protocol: real clicks, drags, win screen, rematch. |
| `Dockerfile` | Single-stage `nginx:1.30-alpine` image: these static files, an unprivileged port, no build step. |
| `nginx.conf` | MIME types, cache headers, gzip and the `try_files` fallback — the whole server config. |
| `docker-compose.yml` | Local run on `:8080`, with a read-only root filesystem and tmpfs for nginx's writable paths. |
| `.dockerignore` | Keeps `tools/`, `README.md` and the git history out of the build context and the image. |
| `.github/workflows/ci.yml` | CI: the two Node suites, the browser checks, and a container smoke test. |

## Determinism

Every random value comes from a mulberry32 stream derived from the seed
(`version`, `terrain`, `spawn`, `wind`, `ridge`), so subsystems cannot
accidentally share a sequence. `Math.random()` is never called — `tools/check-static.js`
and `tools/check-determinism.js` both fail if it appears.

The match advances on a fixed timestep (`1/120 s`, `4` collision substeps) with an
accumulator, so the outcome does not depend on frame rate or on how long a tab was
hidden. Visual effects use their own seeded stream and frame time; they never feed
back into game state.

`TE.game.stateHash(game)` fingerprints terrain, wind, turn, both tanks and the
shell, and is what the browser self-test compares across two runs.

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

**2. Static constraints (6 checks)**

```bash
node tools/check-static.js
```

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
`workflow_dispatch`. Four jobs, nothing installed in any of them:

| Job | Node | What it runs |
| --- | --- | --- |
| `suite` | `22` and `24` | `node tools/check-determinism.js`, then `node tools/check-static.js` |
| `browser` | `22` | `tools/headless-check.sh`, then `node tools/check-ui.js`, against the runner's Chrome |
| `docker` | — | `docker build`, then `curl` the running container for real game markup |
| `publish` | — | Builds and pushes `ghcr.io/<owner>/tanks-evolved` — **only** on `main` or a `v*` tag, and only after the three checks above pass |

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
