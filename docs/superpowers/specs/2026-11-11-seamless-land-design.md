# Seamless land: always show the sharpest imagery, never the swap

Date: 2026-11-11 · Status: draft for approval

## Intent

The person flying should always see the land at full quality and never catch it being rendered in place. Today the tell is unmistakable: blurry squares sharpen one patch at a time, with visible seams between sharp and blurry patches. It is most noticeable **at startup** and **right after a camera switch**.

Where the app is heading (user's words): the camera will mostly sit in one fixed position, with little movement. So the core case is a steady view from the spacecraft while it orbits. The ground still moves at ~7.5 km/s, so new land keeps arriving over the horizon and must also arrive already sharp.

## Goals

1. **Startup:** the loading screen stays up until the land in the first view is at full quality (imagery and elevation at the level the view needs). The first frame the user sees is final. A longer wait is acceptable (user's decision).
2. **Camera switches:** the land for every spacecraft camera is kept loaded in the background, so a switch is normally instant and already sharp. If the target camera's land is not ready, the switch fades through black and fades back in only once it is (user's decision).
3. **Steady flight:** land coming into view along the orbit is loaded ahead of time, so it is sharp before it becomes visible.
4. **Last line of defence:** if a tile still finishes loading while on screen (network hiccup), it must not pop. It blends in gently, and neighbouring tiles do not sharpen one at a time in a visible patchwork.

## Non-goals

- Higher resolution than today (imagery max z13, elevation max z12, same sources: EOX Sentinel-2 cloudless 2020 and AWS Terrarium).
- Changing how the land looks (colour, shading, atmosphere).
- The free-flight camera and the flight planner UI: they keep working, but are not tuned here. Free flight may still show refinement when flying fast or far.
- Clouds (currently off).

## Anti-goals (failure even if it "works")

- A loading screen that can hang forever (offline, slow server, a tile that 404s).
- A visibly lower frame rate, stutter when tiles upload, or memory growth that never stops.
- Fades on every camera switch. The fade is only a fallback when land is not ready.
- Hammering the upstream tile servers so they rate-limit or block us.

## Constraints and context

- Single-file bundle built by `node build.js` from `src/`. Top-level names must be unique across files.
- Tiles are fetched directly from the CDNs when the page is opened as a file, or through `server.js`, which caches them on disk under `tilecache/` when served (`start.bat`).
- Testing in the hidden in-app browser pane: rAF is frozen there. Use `resize_window`, then `__sx.step(n)` and `__sx.settle(ms)` (see `src/main.js`).
- Typical machine: RTX 3060, 1440p. Current frame cost is ~20 ms/frame on the GPU.

## Why it happens today (findings, `src/earth.js` TileManager)

1. **The loading screen ignores the land.** It hides on the three.js `LoadingManager.onLoad` (`src/main.js`, `manager.onLoad`). That only tracks the base textures and the spacecraft model. Tiles are loaded with `fetch` outside the manager. So the screen lifts while the ground is still the coarse fallback.
2. **Only the current camera's land is loaded.** `TileManager.update()` selects tiles for the *current* camera's frustum and field of view only. After a camera switch, the new view's detail tiles have never been requested. Tiles unused for 90 frames are eligible for eviction.
3. **Swaps are instant and per tile.** While a tile loads, it is drawn with its nearest loaded ancestor's texture, which is blurry (`uUvXform` fallback chain). The frame it arrives, it switches to its own texture. Elevation switches the same way, so the geometry jumps too. Each tile does this independently, which makes the patchwork.
4. **Nothing loads ahead along the orbit.** Tiles are requested only once they are in the frustum. The flight planner (`L`) can pre-download a whole orbit to disk, but it is manual and separate.

## Design

### 1. Readiness

The tile manager can report, for a given view (camera position, orientation, field of view, viewport height), whether every tile that view needs is at its **own** target level for both imagery and elevation. It reports this as "ready" or as a fraction of tiles ready.

- "Needs" uses the same LOD rule as drawing (`lodPx`), so ready means "what will be drawn is final".
- A tile that has failed permanently (error after retries, e.g. ocean tiles that 404) counts as resolved, and draws with its ancestor as today. It must not block readiness.

### 2. Background loading for every spacecraft camera

Each frame, besides the camera being drawn, the tile manager also runs selection (without drawing) for:

- every spacecraft camera mode: chase plus the four hull cameras (`HULL_CAMS`), at each one's current pose and field of view;
- the same set at **predicted positions ahead along the orbit**, using the same orbit model as the sim/planner.

These tiles are marked as in use, so they are not evicted, and they are queued for loading. The drawn view comes first, then the other cameras now, then the look-ahead.

- Hull cameras can be dragged to look around (`hullLook`). Each background view is selected with some margin around its frustum, so small look-arounds stay sharp.
- To keep the cost down, the background views do not all need re-selecting every frame. Round-robin them, and re-select when the spacecraft has moved a set distance.

### 3. Startup gate

The loading screen stays up until the start view is ready (section 1), in addition to today's `manager.onLoad`.

- The progress bar reflects the land too, so a long wait visibly progresses.
- A safety timeout lifts the screen anyway, with a short note that imagery is still loading, so it can never hang forever (anti-goal). Value: builder's call, around 60 s.
- Starting other cameras' land during the startup wait is allowed, but must not delay the start view.

### 4. Camera switch with fade fallback

On a camera switch (`setCamMode`):

- If the target view is ready, cut instantly, as today.
- Otherwise, fade to black quickly, switch, hold black until the target view is ready, then fade in. Also use a timeout here, so the screen never stays black; when it expires, fade in anyway.
- Fade timings and timeout: builder's call. Aim for something like a short film cut: about 0.2–0.3 s out and in, with a hold of a few seconds at most.
- Destination jumps (`1`–`0` keys) behave like camera switches: fade, load, fade in.

### 5. No pops when a tile still arrives on screen

- **Cross-fade:** when a visible tile's own imagery or elevation arrives, blend from the ancestor version to its own over a short time (roughly 0.3–0.5 s, builder's call) instead of switching in one frame. The shader blends between the ancestor and own textures, and between the ancestor and own heights.
- **Refine as a group:** when a tile refines into its four children, show the children only once all four have arrived. Until then, keep drawing the parent at its own resolution. This removes the one-patch-at-a-time patchwork. Siblings that cannot load (permanent error) do not block the group.

### 6. Memory, uploads and network limits

- Tiles kept for background views count against the eviction budget. Raise or adapt the budget to the extra views, and evict the look-ahead tiles of the past orbit first (the ones the spacecraft has passed).
- GPU texture uploads (and `generateMipmaps`) can cause hitches if many tiles arrive in one frame. Cap uploads per frame for tiles not in the drawn view.
- Keep within today's parallel-request limits (`maxInflight` 32 imagery, 16 elevation), or adjust carefully; the upstream servers rate-limit. `server.js` already caches every tile on disk when served.

## Scope calls (author's calls, not the user's; flagged for review)

- **Speed and time warp:** the guarantees hold at normal speed (time warp ×1, orbital speed ×1, including small W/S nudges). At higher warp or speed, land may refine in view, softened by the cross-fade and group refine. Changing warp does not fade.
- **Simulation during waits:** the sim is paused while the loading screen is up and while a fade holds on black, so readiness isn't chasing a moving target. After the startup wait, the clock resumes from where it was set (it falls behind real time by the wait; `N` re-syncs).
- **Night side:** readiness counts every tile that is drawn, day or night, and does not try to save on dark tiles. The start stays at the real current time. Daylight checks set the time with `[`/`]` or `sim.utc`.
- **View changes that are not covered:** hull-camera zoom, free look beyond the frustum margin, steering, climbing, attitude changes and chase-camera drag/distance may refine in view (with cross-fade and group refine), like free flight. This follows the user's direction that the camera will mostly stay fixed. Destination jumps (`1`–`0`) are the only "jump" that fades.
- **Opening as a file:** `start.bat` (served, disk cache) is the supported mode for these goals. Opened as a file, the same code runs on a best-effort basis: look-ahead only for the drawn camera, and the same request limits.

## Left to the builder

- Exact look-ahead time and spacing along the orbit (start from fetch latency × ground speed, with a healthy margin: likely 20–60 s ahead).
- Frustum margin for hull-camera look-around, fade and cross-fade timings, and timeouts.
- How readiness and progress are exposed (e.g. `tiles.readiness(view)`), and whether the background views reuse `collect()` or `update()`'s selection.
- Upload-per-frame cap, and the eviction budget numbers.
- Whether the flight planner reuses the new look-ahead code.

## Done when

Verified in the browser (screenshots plus numbers from `__sx`):

- After the loading screen lifts, the first frames show no tile still on fallback imagery (readiness = 100%), in daylight at the default start.
- Cycling through all cameras (`C`) after a minute of flight: switches are instant with no fallback tiles visible. Or, if forced (cold cache, throttled network), the fade hides the load and the view fades in sharp.
- Steady flight for several minutes on a hull camera: the count of visible tiles drawn on fallback stays at 0, or near 0 with cross-fades only.
- Frame time within ~10% of today's, with no upload hitches visible, and memory bounded over a long flight.
