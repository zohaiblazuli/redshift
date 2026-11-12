# SPHEREx Orbit — photorealistic open world in the browser

Fly NASA's SPHEREx space telescope around a full-scale, streaming Earth.

## Run

Double-click `index.html` (it is fully self-contained), or double-click `start.bat` to serve it at http://localhost:8080 (needs Node.js).
An internet connection is required (three.js, imagery and textures stream from public CDNs / EOX / AWS).
If something goes wrong at start-up, the loading screen now shows the error.

The real-cloud data in `data/clouds/` only loads when the page is served (`start.bat`); opened as a plain file, a climatological cloud map stands in.

Use `start.bat` for offline flights: the local server keeps every map tile it fetches in `tilecache/` (delete the folder, or use **Clear cache** in the flight plan, to reclaim the space).

## Spacecraft model

The spacecraft is `models/spherex.glb`, exported from the Blender file `SPHEREx_Master.blend` (textures from `G:\SPHEREX-BLENDER\textures`, downscaled to 2K, solar array 4K, WebP). It only loads when the page is served (`start.bat`); opened as a plain file, the older procedural model in `src/spherex.js` stands in. To re-export after editing the .blend:

```
blender -b SPHEREx_Master.blend --python tools/export_spherex.py -- models/spherex.glb
```

## Flight plans (offline tiles)

Press `L`. The planner flies the orbit ahead from where the spacecraft is now (¼, ½, 1 or 3 orbits), runs the ground tile selection at every point for all the spacecraft cameras at the current window size, and lists exactly the tiles the flight will show — at the finest detail the cameras can resolve, and no finer. **Download** stores them in `tilecache/` (in track order, so you can start flying early); **Fly** resumes the orbit. Typical size: ~0.6 GB per orbit at 1440p (about 0.1 GB imagery, 0.5 GB terrain), roughly 2× that at 4K.

## Editing

Source lives in `src/` (`template.html` + ES modules). After changing it, run `node build.js` to regenerate the bundled `index.html`. The bundle puts every module in one scope: top-level names must be unique across files, and imports of the same module must use the identical line.

## Lighting hub and cloud slot

All light comes from one place, `src/lighting.js`: the sun (direction, irradiance, colour after the air), the precomputed atmosphere and a shared **cloud shadow map**. three.js materials spread `lighting.uniforms`. Raw WebGL2 code prepends `lighting.glsl`, which provides `sunTransmittance`, `skyIrradiance`, `aerial` and `cloudShadowT`, and calls `lighting.bind(gl, program, unit)`.

An external cloud renderer plugs in through `src/cloudslot.js`, which also documents the contract:
- **Usage:** `__sx.setCloudProvider({ init(gl, lighting), resize(w, h), render(frame), dispose() })`.
- **Each frame:** the provider writes a premultiplied cloud image and the shared shadow map. Ground, sea, haze, the environment probe and the spacecraft then pick the shadows up on their own.
- **Template:** `src/exampleclouds.js` is a complete minimal provider (one raymarched cumulus cluster). Try it with `?clouds=example`.
- **Cost with nothing attached:** nothing; the map is not even allocated.

**Clouds are currently off everywhere:** `CLOUDS_ENABLED = false` in `src/earth.js` switches off every built-in cloud, its shadows and its data loads, and no provider is attached by default. Test providers can be attached on request:
- `?clouds=greece` attaches `src/regionclouds.js`, raymarched cumulus over the Ionian Sea / Greece (30–47°N, 8–30°E). A provider with a lat/lon `box` cuts the built-in clouds out of that box.
- `?clouds=example` attaches the template provider.
- `?clouds=cloudworks` attaches `src/cwclouds.js`: the CloudWorks clouds over the whole planet, placed from the observed day. This is phase 2 of `docs/superpowers/specs/2026-10-15-cloudworks-integration-design.md`.
- `?clouds=cloudworks-lineup` shows the ten genera in a row instead, placed where the camera looks or with `__sx.cloudSlot.provider.lineupAt(lat, lon)`.

## CloudWorks clouds

The cloud shapes come from the separate CloudWorks project (`../CloudWorks`), which remains their source of truth. `node build.js` bundles its shared core `CloudWorks/src/cloudcore.js` and copies its original cumulus volume to `data/cloudworks/legacy-cumulus.gz`. Set `CLOUDWORKS=<folder>` if the project lives elsewhere. Edit shapes in CloudWorks, then rebuild both apps.

- **Generation:** `src/cwclouds.js` generates the atlas in the browser with CloudWorks' own code, 24 layers per frame (~70 frames).
- **Same atlas:** for the same shape seed, `__sx.cloudSlot.provider.atlasChecksum()` equals Groundview's atlas hash (`db480cbc/2996030` for seed 1).
- **Far field (phase 2):** for each genus, `src/cwstats.js` measures the column optical depth, the in-cloud extinction by height, the thickness and the aspect ratio from the generated shapes (`provider.stats`).
  - `src/cwfar.js` classifies every ~5 km cell of the observed day into the ten genera, using ISCCP classes (cloud-top height × optical depth, plus cover and ice).
  - Each genus is scaled so its column optical depth matches the observed one, between the observed top and a base derived from its thickness.
  - A cell is drawn as a mixture: the cloud as it is over the covered fraction, clear air elsewhere.
  - It writes the shared cloud shadow map, which shadows the ground, sea, haze and spacecraft, and the clouds on each other.
  - Cost at 1440p (RTX 3060): 3.5–4.9 ms with the cloud image at 38 % resolution. The comparison with the VIIRS image is in `docs/superpowers/qa/`.
- **Mid field (phase 3, in progress):** where a genus's clouds span more than ~5 pixels, its real CloudWorks shapes are drawn.
  - Placement: three offset jittered grids per genus on an equal-angle cube, one cloud per cell at most. Cells are sized to the cloud's measured reach, and the presence probability makes the footprints add up to the observed cover.
  - Variation: 45° turns, mirroring and ±22 % size.
  - Crossfade: per genus with the far field. Cover the separate clouds can't supply (overcast decks) is filled by the far field.
  - Speed-ups:
    - Clear air: a map of the highest cloud top nearby (built once per day, 4 levels from ~20 to ~160 km) lets rays above the clouds, or in cloudless areas, jump tens of kilometres without reading the weather cell by cell.
    - Between shapes: each shape lookup also returns a radius known to be empty. It comes from the grid layout and from CloudWorks' empty-distance grid inside a cloud's box. The march jumps that radius, skips lookups within it, and reads no atlas texels in empty cells.
    - Light shares: a cell whose far-field cover (or shape weight) is small is left sooner and stepped deeper, since its error is weighted by that share.
    - Rays that have crossed many cloudy cells (grazing at the horizon, where each cell adds a sliver to one pixel) step progressively coarser. Orbit views cross only a few cells and are unchanged.
  - Diagnostics: `provider.gpuTimer` / `provider.gpuTimes` time the passes. Per-pass GPU timers mislead here, because the second pass absorbs the end of the first. Time whole frames with nothing else using the GPU. Interleave the settings you compare (A, B, A, B…), because this GPU's clock state drifts by up to 2× between runs.
  - Cost at 1440p, colour + shadow map: orbit ~7.5–10 ms; free flight ~20–29 ms, nearly all of it in the strip of sky just above the horizon.
- **Near field and calibration (phase 4, in progress):**
  - Brightness: the clouds' light (`cwCalibGLSL` in `src/cwfar.js`) is calibrated to Groundview against an 18 % grey card under the same sun. That is what each app's exposure holds steady. Groundview's sky is brighter relative to its sun, so CloudWorks clouds take 2.9× OpenWorld's sky light and 70–88 % of its sunlight, depending on sun elevation. Measured with both apps' sky models.
    - Tone curve: Catalyst's captured city4 filmic and color-grading pass is the default. The Groundview AgX "punchy" curve remains available with `Y`.
  - Near field: within 60 km of the camera, resolved shapes are lit exactly as Groundview lights them. That means three short light steps through the cloud, CloudWorks' far self-shadow cache, top occlusion and height ambient, with the other clouds' shadows from the shared map.
    - The cache (10 genera × 8 orientations, `cwBakeGLSL` from the shared core) is baked for the sun in the camera's cube-face frame, 480 layers per frame. It rebakes when the sun moves ~0.5° or the camera changes face, and not from orbit.
    - `provider.near = false` switches back to the mid field's light.
  - Temporal accumulation (in the cloud slot, `temporal: true` in the provider): the march jitters its rays per frame and writes an opacity-weighted depth. The slot reprojects a display-resolution history with it, clamps to the new frame's neighbourhood and blends 12 % per frame (`cloudSlot.blend`). This removes the stair-stepped edges of the 38 % target.
- **Known:** in Chrome a single GL `INVALID_VALUE` is reported once at startup, by the planet draw of the frame in which the observed-day images finish decoding. No call made by the app fails, and nothing visible changes.

## Real clouds

The clouds are one real day of satellite observations (currently 2026-10-11), baked by `tools/bake_clouds.py` from NASA GIBS:

- VIIRS NOAA-20 / Suomi-NPP and MODIS Aqua / Terra cloud-top height, optical thickness and phase.
- VIIRS true colour against Blue Marble, for sub-pixel cloud fraction.
- VIIRS snow cover, to keep fresh snow from reading as cloud.
- Terrarium elevation, so cloud bases follow the terrain.

**High-resolution region (prototype, currently off — `CLOUD_REGION` in `src/earth.js`):** `python tools/bake_region.py` bakes Italy / the Adriatic (5–30°E, 33–50°N) at ~500 m straight from the VIIRS image. The cloud's own albedo is recovered with a two-stream cloud-over-ground model, re-converted to optical depth in the shader, and lit live. Inside that box the clouds are the real structure of the day; outside it the global ~5 km field applies.

**Cloud shapes from the Blender library:** the 12 cloud types in `blender_clouds/cloud_library.py` (cumulus humilis / mediocris / congestus, cumulonimbus, stratocumulus, stratus, nimbostratus, altocumulus, altostratus, cirrus, cirrocumulus, cirrostratus) give the clouds their shape.
- `blender -b -P blender_clouds/bake_volumes.py` rebuilds the same procedural density graphs as Geometry Nodes and evaluates them on voxel grids, so there is no rendering and the whole bake takes ~15 s. It writes `data/clouds/models/`:
  - heaps: 6 seeds each (4 for cumulonimbus) at 96×96×64;
  - layers: one 48 km tileable patch each, stored *before* the library's coverage threshold, with a cover→threshold table.
- Each ~5 km weather cell is classified from the observations (ISCCP: cloud-top height × optical depth, plus cover) into one of the 12 types.
- Heaps are scattered on jittered grids laid on an equal-angle cube around the planet, with as many clouds per cell as the observed cover needs. Layers are tiled and cut to the observed cover, varied over ~40 km into cells and rifts.
- Density only is exported; lighting, self-shadowing, cloud-on-cloud and ground shadows are computed live by the raymarcher. Clouds smaller than a pixel fade into their averaged extinction.
- `uModelsOn` switches back to the procedural field.

To bake another day, run `python tools/bake_clouds.py YYYY-MM-DD` (needs numpy, pillow and scipy), then set `CLOUD_DATE` in `src/earth.js` and rebuild. Property layers usually lag the imagery by 2–3 days. Raw downloads are kept in `tilecache/gibs/`.

## Controls

| Keys | Action |
|---|---|
| Drag / wheel | look around / zoom (chase), FOV (hull cams), speed (free flight) |
| `C` / `Shift+C` | cycle cameras: Chase · Shield Cam · Nadir Cam · Action Cam · Limb Cam · Free Flight |
| `W` `S` | orbital speed (`O` restores true orbital velocity) |
| `A` `D` | turn the ground track |
| `R` `F` | raise / lower orbit (25 – 4000 km) |
| Arrows, `Q` `E` | rotate the spacecraft · `T` attitude mode · `Backspace` reset |
| `[` `]` | time of day · `,` `.` time warp · `P` pause · `N` sync the clock (and sun) to right now |
| `-` `=` | cloud cover |
| `Z` | Blender cloud models on/off (the procedural clouds are disabled — `PROCEDURAL_CLOUDS` in `src/earth.js` — so off means a clear sky) |
| `B` | air haze over the ground: 100 % (physical) · 75 % · 55 % (default) · 30 % |
| `;` `'` | exposure compensation −/+ 0.5 EV · `U` auto exposure · `J` lens flare · `Y` tonemapper (Catalyst / Groundview AgX punchy / AgX / ACES / Neutral) |
| `G` / `K` | cycle ground / cloud resolution |
| `L` | flight plan: pre-download the orbit ahead |
| `1`–`0` | jump to destinations (Greece, Italy, Bahamas, Himalaya, Nile, Japan, Great Barrier Reef, Hawaii, Iceland, Patagonia) |
| `M` | toggle Sentinel-2 high-res imagery · `X` terrain relief · `H` hide HUD · `?` help |

In Free Flight: `W` `A` `S` `D` move, `Q` `E` down/up, wheel sets speed, `Shift` boosts.

## What's in it

- **Orbit**: SPHEREx's real orbit — 665 km, 97.95° sun-synchronous (dawn-dusk terminator), 7.53 km/s, 97.9 min period, with the Earth turning underneath (the ground track shifts ~25° west per orbit).
- **Earth**: quadtree-streamed imagery tiles — Sentinel-2 cloudless 2020 at every zoom level (2–13) — on a true-scale 6371 km sphere, refined until each 256-pixel tile spans at most 200 screen pixels (1.3–2.6 texels per pixel). Elevation is fetched one zoom level coarser than the imagery.
- **Terrain**: global Terrarium elevation tiles (AWS Terrain Tiles, incl. bathymetry) displace the tile meshes (with skirts against cracks), drive per-pixel relief normals, and are ray-traced against the height field: soft cast shadows toward the sun (true heights, solar-disc penumbra), sky visibility from six horizon rays per pixel, and one bounce of sunlight off the surrounding terrain. `X` cycles relief: ×1 true scale (default) / ×1.6 / ×2.5.
- **Volumetric clouds from real observations**: the whole globe, out to the horizon, raymarched from a ~5 km observed cloud-fraction map (8K) plus cloud-top height, optical thickness and ice fraction.
  - The data picks the regime: cumulus fields, stratocumulus/stratus decks, elevated layers, cirrus, or deep convection with anvils. Extinction comes from the measured optical depth.
  - A 128³ noise volume adds only the unresolved cells, billows and fibres. It is quantile-matched, so every distance covers exactly the observed fraction, and unresolved fields fade to the correct effective transmittance.
  - Lighting uses multiple-scattering octaves, with light sampled in a cone toward the sun plus one long-range sample for shadows from neighbouring towers. Soft ground shadows come from the same density field.
  - Mountains hide the clouds behind them, and the field drifts with latitude-dependent zonal winds as simulated time passes.
  - Rendering uses empty-space skipping plus temporal accumulation at reduced resolution.
- **Sun**: NOAA/Meeus solar ephemeris for the simulated date and time — the app starts at the real current UTC and runs in real time (`N` re-syncs to now) — declination, equation of time and Earth–Sun distance (irradiance ±3.4 %); the HUD shows the date and apparent solar time.
- **Atmosphere**: Hillaire 2020 precomputed scattering (as in Unreal Engine 5) with Bruneton's Earth parameters — transmittance, multiple-scattering and sky-irradiance tables rendered on the GPU at start-up; per-pixel single scattering plus all higher orders, ozone, Earth's shadow with a soft solar-disc edge. Gives the layered blue limb, physically coloured dawn skylight on the ground, aerial haze (`B`) and the orange terminator.
- **Ocean**: GGX sun glint with Cox–Munk wind roughness (gently varying, rolled off below the bloom threshold), close-range wave facets, and reflections that integrate the actual sky along the mirror direction. Bathymetry-aware shallow colour.
- **Night side**: city lights, twilight band. Stars follow the exposure: a camera exposed for the sunlit Earth or spacecraft records black space, so they only appear in eclipse.
- **SPHEREx**: procedural model — three nested photon shields (glossy white outside, mirror inside), hexagonal bus in crinkled MLI, solar array, star trackers, harnesses, telescope. Lit by the real sun (soft shadows, eclipse, limb-reddened light), by a live environment probe of the planet (one cube face per frame), and with ground-truth ambient occlusion (GTAO).
- **Camera**: HDR with centre-weighted auto exposure (±EV compensation), five Catalyst flare shaders and the wide-angle hull-cam lens. The default Catalyst output evaluates the city4 capture's filmic shader and samples the original 32³ colour cube bound by that draw. It also uses the captured dirt texture and vignette. The two-plane `LensReflection` draw samples the scene bloom and adds the reflections after grading, in the game's draw order. Its input is OpenWorld's browser blur pyramid fitted to the captured bloom buffer. `J` toggles the sun flare and lens reflections. The **Action Cam** uses an equidistant fisheye (~120° horizontal in Wide), soft corners, sharpening, a vibrant colour profile, whole-frame metering, and small-sensor noise in dim areas.
- **Catalyst source data**: the lens uses the original Flare10 textures, sampled rotation and captured geometry curves. Regenerate the browser texture pack with `python -I tools/import_catalyst_lighting.py <Catalyst2Roblox checkout>` using the checkout's existing captures.

Imagery: Sentinel-2 cloudless 2020; elevation: Mapzen / AWS Terrain Tiles; Sentinel-2 cloudless 2020 by EOX IT Services GmbH (CC BY-NC-SA 4.0, contains modified Copernicus Sentinel data); cloud observations: NASA GIBS (VIIRS / MODIS, Blue Marble); fallback clouds and night lights from NASA Visible Earth via the three.js examples.
