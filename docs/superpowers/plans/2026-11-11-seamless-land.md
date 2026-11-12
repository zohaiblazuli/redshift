# Seamless Land Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The land is always shown at full quality. It is never visibly swapped from blurry to sharp at startup, on a camera switch or in steady flight.

**Architecture:**
- The tile manager in `src/earth.js` gains a side-effect-free selection (`select(view)`), a readiness report, background loading for extra views (every spacecraft camera, now and ahead along the orbit), group refinement and a per-tile cross-fade in the ground shader.
- Camera pose maths moves out of `src/main.js` into a pure `src/campose.js`, so background views use the exact poses the cameras will have.
- `src/main.js` adds a startup gate and a fade-through-black for camera switches and teleports. Both pause the sim while they wait.

**Tech Stack:** three.js r170 (CDN import map), plain ES modules bundled by `node build.js` into `index.html`, Node static server `server.js`. There is no test framework and no npm. Tests are browser checks, run with the preview pane's JavaScript tool against the `window.__sx` debug handle, with explicit expected values.

**Spec:** `docs/superpowers/specs/2026-11-11-seamless-land-design.md`

## Global Constraints

- After every source change, run `node build.js`. It must print `index.html built (...)`. Tests run against `index.html` served by the `openworld` preview (`node server.js 8080`). Reload the page after each build.
- Bundle rule: top-level names must be unique across all `src/*.js` files, and imports of the same module must use the identical line. Add a new module to `order` in `build.js` before any module that imports it.
- Hidden preview pane: rAF is frozen and CSS transitions stall. Before checks, call `resize_window` (800×450), hide `#loader` by hand only where a step says so, and drive frames with `__sx.step(n)` / `await __sx.settle(ms)`. Anything time-based (fades, cross-fades, timeouts) must advance with the `dt` passed to `tick`, never with CSS transitions or wall-clock timers.
- Normal speed only: guarantees hold at `sim.warp === 1`, with `sim.speedMul` near 1.
- Do not raise the upstream request limits: at most 32 imagery and 16 elevation requests in flight.
- Frame time must stay within ~10% of today's. Measure the baseline in Task 1 and the result in Task 7.
- Commits: the repo has no commits yet, and the user has not asked for any. The "Checkpoint" steps are commits only if the user asks. Otherwise skip them.

## Review Focus

1. **Tiles that never load (ocean or 404 tiles, three failed attempts)** must count as resolved, so the startup gate and the fade never wait on them. Covered by a test in Task 2.
2. **Offline, or the tile server down:** the loading screen lifts after the timeout, with a note, and never hangs. Covered by a test in Task 5 (`?gatetimeout=3`).
3. **The user's own pause (`P`)** survives the gate and fade pauses. A paused orbit stays paused afterwards, and a running one resumes. Covered by tests in Tasks 5 and 6.
4. **Pressing `C` repeatedly during a fade** must not stack fades or leave the screen black. The last requested camera wins. Covered by a test in Task 6.
5. **Resizing the window** (a new `viewportH`) changes what "ready" means. Readiness is recomputed from the current size, with no stale cache. Covered by a test in Task 2.

---

### Task 1: Pure camera poses (`src/campose.js`)

**Files:**
- Create: `src/campose.js`
- Modify: `src/main.js` (`updateCamera`, around lines 523–551; `CAM_MODES` stays in `main.js`)
- Modify: `build.js` (`order`: add `'campose.js'` after `'spherex.js'`)

**Interfaces:**
- Produces: `export function cameraPose(mode, sim, orbitCam, hullLook, out)`.
  - `mode`: integer `0` (chase) to `HULL_CAMS.length` (hull cameras). Free flight is not handled.
  - `out = { offset: THREE.Vector3 /* camera offset from spacecraft, metres, world frame */, quat: THREE.Quaternion, fov: number }`. Returns `out`.
  - `sim` needs only `.p`, `.f` and `.att`.
  - World-camera position is `sim.posKm + offset * 0.001`, exactly as `updateCamera` does today.
- Produces: `export function viewFromPose(sim, pose, aspect, viewportH, out)`. Returns `out = { pos: THREE.Vector3 /* km */, quat, fov, aspect, viewportH }`. This is the `View` type used by Tasks 2–6.

- [ ] **Step 1: Record the baseline.** Build and reload. In the preview run:
  `for m of 0..4: __sx.setCamMode(m); __sx.step(2); record worldCam.position.toArray(), worldCam.quaternion.toArray(), worldCam.fov`.
  Run with `__sx.sim.paused = true` so poses don't drift between runs. Also record a frame-time baseline: a `performance.now()` delta around `__sx.step(60)`, median of 3.
- [ ] **Step 2: Write the check `campose-matches-updateCamera`.** For each `m` in 0..4, compute `viewFromPose(sim, cameraPose(m, sim, orbitCam, hullLook, {...}), aspect, h, {...})`. Assert that `pos` is within 1e-6 km of the recorded `worldCam.position`, each quaternion component within 1e-6, and `fov` equal. Expose `cameraPose` and `viewFromPose` on `__sx` for the check.
- [ ] **Step 3: Run it.** Expected: it fails with `__sx.cameraPose is not a function`.
- [ ] **Step 4: Implement.** Move the three pose branches (chase, hull) from `updateCamera` into `cameraPose`. `updateCamera` calls it for modes other than free flight, then sets `satCam`/`worldCam` from the result. Free flight keeps its inline code.
- [ ] **Step 5: Run the check and Step 1's recording again.** Expected: all 5 modes match, and the screenshots of chase and shield cam look unchanged.
- [ ] **Step 6: Checkpoint.**

### Task 2: Selection and readiness in the tile manager

**Files:**
- Modify: `src/earth.js` (`TileManager`: refactor `update()`'s `visit` into `select`; add `readiness`, `report`)

**Interfaces:**
- Consumes: `View` from Task 1.
- Produces, on `TileManager`:
  - `select(view, marginRad = 0) -> Tile[]`: the leaf tiles the LOD rule (`lodPx`, `maxZ`) picks for that view. The frustum is built from `view` with its half-FOV enlarged by `marginRad`. No loading and no `lastUsed` changes.
  - `tileResolved(t) -> boolean`: own imagery is `ST_READY` and uploaded (Task 3 adds the `uploaded` flag; until then, use `ST_READY`), or `ST_ERROR` with `errors >= 3`. **And** its elevation tile at `demZ(t.z)` is `ST_READY`, or has errored 3 times.
  - `readiness(view, marginRad = 0) -> { resolved: number, total: number, ready: boolean }`: `ready === (resolved === total)`.
  - `report() -> { drawn, fallback }`: counts for the last drawn frame. Task 4 adds `crossfading` and `mixedSiblings`. `fallback` = drawn meshes using an ancestor's imagery or elevation instead of their own.
- `update(camera, camPos, viewportH)` keeps its signature and builds a `View` from the camera, then uses `select`.
- Elevation errors: `loadHeight`'s catch must also set `t.herrors = (t.herrors || 0) + 1` and allow retry, as imagery does (retry after 300 frames, up to 3 times).

- [ ] **Step 1: Write the checks.** Expose `__sx.landReady(mode)` = `tiles.readiness(viewFromPose(...cameraPose(mode...)))`.
  - `readiness-settles`: after `await __sx.settle(30000)` with the start camera, `__sx.landReady(1).ready === true` and `__sx.world.tiles.report().fallback === 0`.
  - `errored-tile-counts-resolved` (Review Focus 1): take a tile from `select(...)`, set `state = 3` (`ST_ERROR`) and `errors = 3`, then assert `tileResolved(t) === true`.
  - `resize-recomputes` (Review Focus 5): `readiness` for viewportH 450 versus 1440 on the same pose gives different `total`, larger for 1440.
- [ ] **Step 2: Run them.** Expected: they fail with `landReady is not a function`.
- [ ] **Step 3: Implement** `select`, `tileResolved`, `readiness`, `report`, the `update` refactor and the elevation retry.
- [ ] **Step 4: Run the checks.** Expected: all three pass, and the drawn view looks unchanged.
- [ ] **Step 5: Checkpoint.**

### Task 3: Background loading — every camera, now and ahead

**Files:**
- Modify: `src/earth.js` (`TileManager.update` gains extra views; priority queue; upload cap; eviction budget)
- Modify: `src/main.js` (build the background views each frame and pass them through `world.update`)
- Modify: `src/earth.js` `createWorld().update(camera, camPos, viewportH, sunDir, extraViews = [])` → `tiles.update(camera, camPos, viewportH, extraViews)`

**Interfaces:**
- Consumes: `select`, `tileResolved` (Task 2), `cameraPose` and `viewFromPose` (Task 1).
- Produces:
  - `TileManager.update(camera, camPos, viewportH, extraViews = [])`. `extraViews` is an array of `{ view: View, cls: 1 | 2 }`: 1 = other cameras now, 2 = look-ahead.
  - Loading priority is class 0 (drawn) first, then 1, then 2. Within a class, coarse levels first, then nearest (today's rule).
  - `extraViews` tiles get `lastUsed = frame`, so they are not evicted.
  - The eviction budget becomes `max(520, ceil(1.8 * (drawn + uniqueBackgroundTiles)))`.
  - Tiles behind the spacecraft (look-ahead views it has passed) are no longer in any view, so they age out normally.
- Produces: `Tile.uploaded` (boolean). Tiles in the drawn view upload as they become ready. Others go through `renderer.initTexture(tex)` at most `UPLOADS_PER_FRAME = 4` per frame, then get `uploaded = true`. `tileResolved` requires `uploaded`.
- In `main.js`:
  - `HULL_MARGIN = 0.15` rad, applied to hull and chase views (look-around).
  - Look-ahead uses a predicted sim: copy `p`, `f`, `alt`, `speedMul`, `utc`, `doy`, `year`, `attMode`, `attOffset`; set `warp = 1` and `paused = false`; advance with `update(step, {})` like `planner.js`; take `att = attitudeTarget()`.
  - `LOOKAHEAD_S = [15, 30, 45]`.
  - Background views = modes 0..4 at "now" (class 1, skipping the drawn mode) plus modes 0..4 at each look-ahead time (class 2). That's 19 views.
  - Re-select them round-robin, `VIEWS_PER_FRAME = 3`, caching each view's tile list between refreshes.
  - Skip look-ahead when `sim.warp > 1` or `sim.speedMul > 1.5`.
  - Opened as a file (`!tileCache.available`): only the drawn camera's look-ahead, and no other cameras.

- [ ] **Step 1: Write the checks.**
  - `all-cameras-ready`: after `await __sx.settle(60000)`, `[0,1,2,3,4].every(m => __sx.landReady(m).ready)`.
  - `switch-is-sharp`: then for each m, `__sx.setCamMode(m); __sx.step(1)`, and `report().fallback === 0`.
  - `ahead-is-ready`: unpause, step 30 s of sim time (`__sx.step(1800)`), `settle(20000)`, then `report().fallback === 0`.
  - `bounded`: `world.tiles.tiles.size < 6000` after 5 simulated minutes.
- [ ] **Step 2: Run them.** Expected: `all-cameras-ready` fails today (other modes are not ready).
- [ ] **Step 3: Implement** the earth.js changes (extra views, classes, `uploaded` and cap, budget).
- [ ] **Step 4: Implement** the main.js view building (round-robin, look-ahead, skip rules).
- [ ] **Step 5: Run the checks and time 60 frames as in Task 1.** Expected: all pass, and frame time is within 10% of the baseline.
- [ ] **Step 6: Checkpoint.**

### Task 4: Group refine and cross-fade

**Files:**
- Modify: `src/earth.js` (`groundVert`, `groundFrag` and the material uniforms at ~line 830; drawing in `TileManager.update`)

**Interfaces:**
- Consumes: `select`, `tileResolved`, `report` (Task 2).
- New shader uniforms, all per tile material:
  - `uMapPrev`, `uUvXformPrev` (vec4), `uMapMix` (float, 1 = own/new only)
  - `uHeightPrev`, `uHXformPrev`, `uHMix`
  - `uHasHeightPrev`
- Every imagery sample in `groundFrag` (the `alb` line) and every height sample (`hAt`, the vertex `disp`, `huv` uses) becomes `mix(prev, new, mix)`. Put one GLSL helper each for imagery and height, so all call sites stay one-liners.
- **Group refine (drawing only, selection unchanged):** walk the selected leaves as a quadtree from the z2 roots.
  - At node N: if every selected leaf under N is resolved, recurse into the children.
  - Else, if N has its own imagery and elevation ready, draw N as one tile.
  - Else, recurse anyway (per-tile ancestor fallback, as today).
  - Siblings that have permanently failed count as resolved.
- **Cross-fade:** each drawn mesh remembers the imagery and height source it showed last frame (`tile key`, `d`). When the source becomes finer, copy the old source into the `*Prev` uniforms, set the mix to 0, and raise it by `dt / FADE_S` each frame, with `FADE_S = 0.4`. `dt` must be passed into the tile manager. The final signatures are `TileManager.update(camera, camPos, viewportH, extraViews = [], dt = 0)` and `createWorld().update(camera, camPos, viewportH, sunDir, extraViews = [], dt = 0)`, with `dt` threaded from `tick`. A mesh drawn for the first time starts at mix 1, with no fade from nothing.
- `report()` gains two fields: `crossfading` (meshes with a mix below 1) and `mixedSiblings` (drawn tiles whose parent is selected-refined but only some of the parent's four children are drawn at their own level; must always be 0).

- [ ] **Step 1: Write the checks.**
  - `group-refine`: settle on cam 1; set `tiles.hiRes = false`, `step(5)`, `settle()`; then set `hiRes = true` and immediately `step(1)`. Assert there is no frame (over the next 120 steps of `dt = 1/60`) where a drawn parent has some but not all of its children drawn. Test it with a `report().mixedSiblings` counter that the implementation keeps, which must be 0.
  - `crossfade-runs`: during the same run, `report().crossfading > 0` on some frame, and 0 again after 0.5 s of steps.
- [ ] **Step 2: Run them.** Expected: they fail (`mixedSiblings` undefined).
- [ ] **Step 3: Implement** the shader helpers and uniforms.
- [ ] **Step 4: Implement** group-refine drawing and the cross-fade bookkeeping.
- [ ] **Step 5: Run the checks.** Then screenshot the hiRes toggle mid-fade: no hard square seams should be visible.
- [ ] **Step 6: Checkpoint.**

### Task 5: Startup gate

**Files:**
- Modify: `src/main.js` (`manager.onLoad` handling near line 694; the `tick` loop; the progress bar)
- Modify: `src/template.html` (a line under the loader for the "still loading" note: `<div id="loadnote"></div>`, styled like `.sub` text)

**Interfaces:**
- Consumes: `readiness`, `cameraPose`, `viewFromPose`.
- Produces: `gate = { phase: 'assets' | 'land' | 'done', t: 0, userPaused: boolean }` on `__sx.gate`.
  - While the phase is not `'done'`, `sim.paused = true`. The user's paused value is saved in `userPaused` at startup and restored on `'done'`.
  - `'land'` starts when `manager.onLoad` fires.
  - It ends when the start camera's readiness is ready, or after `GATE_TIMEOUT_S = 60`.
  - The timeout can be overridden with the URL parameter `?gatetimeout=<s>`.
  - On timeout, `#loadnote` reads "Imagery still loading — it will sharpen shortly." for 6 s.
- The progress bar shows assets as the first 30%, then `30 + 70 * resolved / total`.

- [ ] **Step 1: Write the checks.**
  - `gate-waits`: reload, then poll every 250 ms until `#loader` has class `done`. At that moment, `report().fallback === 0` and `landReady(1).ready`.
  - `gate-timeout` (Review Focus 2): reload with `?gatetimeout=3` and offline tiles (the hardcoded elevation limit of 16 becomes a `TileManager.hMaxInflight = 16` property; a `?offline=1` test parameter read in `main.js` sets both `maxInflight` and `hMaxInflight` to 0 at startup). Within ~3 s of sim `dt` after assets load, `#loader` is `done` and `#loadnote` is not empty.
  - `gate-keeps-user-pause` (Review Focus 3): call `__sx.sim.paused = true` before the gate ends; after it ends, still `true`. The default run ends with `sim.paused === false`.
- [ ] **Step 2: Run them.** Expected: `gate-waits` fails today (fallback > 0 when the loader lifts).
- [ ] **Step 3: Implement** the gate, the progress bar, the note and the test parameters.
- [ ] **Step 4: Run the checks.** Expected: all pass.
- [ ] **Step 5: Checkpoint.**

### Task 6: Fade-through-black on camera switch and teleport

**Files:**
- Modify: `src/template.html` (`<div id="fade">`: full screen, black, `pointer-events: none`, opacity set from JS; above the canvas, below the HUD toasts)
- Modify: `src/main.js` (`setCamMode`, `teleport`, `tick`)

**Interfaces:**
- Produces: `fade = { state: 'idle' | 'out' | 'hold' | 'in', a: 0, target: null | (() => void), t: 0, userPaused }` on `__sx.fade`.
- `requestView(applyFn, readyFn)`:
  - If `readyFn()` is already true, call `applyFn()` immediately (instant cut).
  - Otherwise: `'out'` (raise `a` to 1 over `FADE_OUT_S = 0.25`), then call `applyFn()` and enter `'hold'` (sim paused; wait until `readyFn()` or `HOLD_TIMEOUT_S = 4`), then `'in'` (lower `a` to 0 over `FADE_IN_S = 0.25`) and restore the pause.
  - A new request during `'out'` or `'hold'` replaces `target`/`readyFn` and keeps the state; the timer restarts on the new `'hold'`. A request during `'in'` goes back to `'out'` from the current `a`.
- `setCamMode(m)` for modes 0..4 calls `requestView(() => applyCamMode(m), () => landReady(m).ready)`. Free flight cuts instantly, as today.
- `teleport(place)`: the ready check is evaluated after applying the place. So `requestView` with `readyFn = null` always fades, and `'hold'` waits on `landReady(camMode)`.

- [ ] **Step 1: Write the checks.**
  - `warm-switch-instant`: after the Task 3 settle, `__sx.setCamMode(2)`; `fade.state === 'idle'` and `camMode === 2` straight away.
  - `teleport-fades-in-sharp`: press `Digit7` (dispatch a `keydown`); step frames; observe `'out'`, then `'hold'`, then `'in'`, then `'idle'`; at the first `'in'` frame, `report().fallback === 0`.
  - `spam-c` (Review Focus 4): during a forced fade (teleport), call `setCamMode` 5 times in a row; within `4 + 0.5` s of steps, `fade.state === 'idle'`, `a === 0`, and `camMode` equals the last requested mode.
  - `fade-keeps-user-pause` (Review Focus 3): `sim.paused = true`, teleport, and after `'idle'` it is still `true`.
- [ ] **Step 2: Run them.** Expected: they fail (`__sx.fade` undefined).
- [ ] **Step 3: Implement** `#fade`, `requestView`, and the `setCamMode`/`teleport` wiring.
- [ ] **Step 4: Run the checks.** Then screenshot one teleport mid-hold (black) and right after `'in'` (sharp).
- [ ] **Step 5: Checkpoint.**

### Task 7: End-to-end verification and docs

**Files:**
- Modify: `README.md` (a short "Seamless land" section: the loading screen waits for full-quality land; background loading for all cameras and 45 s ahead; fades on switch and teleport; normal speed only; `start.bat` recommended; test parameters `?gatetimeout=`, `?offline=1`)

- [ ] **Step 1: Run every check from Tasks 1–6 in one fresh reload, in order.** Expected: all pass.
- [ ] **Step 2: Steady flight.** On SHIELD CAM, at warp ×1, step 5 minutes of sim time in 1 s chunks, reading `report().fallback` each chunk. Expected: 0 every time, with only `crossfading` allowed to be non-zero.
- [ ] **Step 3: Frame time.** Repeat the Task 1 timing. Expected: within 10% of the baseline. Also expect `tiles.size` and `loadedCount` to stay flat over the last 2 minutes.
- [ ] **Step 4: Screenshots for the user**, in daylight (`sim.utc` set to local noon): the first frame after the loader lifts, and a camera switch.
- [ ] **Step 5: Update the README and rebuild.**
- [ ] **Step 6: Checkpoint.**
