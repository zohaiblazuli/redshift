# CloudWorks clouds in OpenWorld: integration design

Date: 2026-10-15 · Status: approved. Phase 1 done (2026-10-15). Phase 2 done (2026-10-15): far field from the observed day, comparison in `docs/superpowers/qa/2026-10-15-phase2-far-field-vs-viirs.jpg`. Phase 3 (mid field) done and optimised (2026-10-15). Phase 4 in progress (2026-10-16):
- Brightness calibrated per light term against a grey card. The tone curve choice is open.
- Temporal accumulation is in the slot.
- Near field: changed from the planned separate 64-instance marcher to Groundview's lighting applied to the mid field's own resolved shapes within 60 km. Shapes and placement are identical, so there is no tier boundary to pop. The self-shadow cache is baked for the camera's local frame.

## Goal

Replace OpenWorld's (now disabled) clouds with the user's CloudWorks clouds: the ten genera plus the original baked cumulus. The globe should look convincing from the default 665 km orbit first; close-up free flight comes later. Clouds are placed from the real observed day already baked for OpenWorld. CloudWorks stays the source of truth for cloud shapes and in-cloud lighting, and OpenWorld picks up changes with a rebuild.

### Decisions (user, 2026-10-15)
- **Placement:** the real observed day (NASA GIBS bake in `data/clouds/2026-10-11/`).
- **Source:** CloudWorks remains the source of truth. A shared module is imported by both apps.
- **Priority:** the orbit view first, then the mid field, then the near field.

## What CloudWorks provides (as of the working copy, 2026-10-15)

| Part | Where (`CloudWorks/src/template.html`) | Reuse |
|---|---|---|
| Ten genera: morphology, altitude band, scale, density, wind (`TYPES`, `TYPE_ORDER`) | ~1114 | verbatim |
| Lobe layouts for heaps and storms (`makeLobes`) | ~1127 | verbatim |
| GPU sculptor: lobe, cellular, layer and filament density (`genFs`) | ~230 | verbatim |
| Density sampling and edge detail (`common`: `sampleCloud`, `shadowDensity`, `toLocal`) | ~207 | verbatim |
| Occupancy and empty-distance grids (`occFs`, `buildEmptyDist`) | ~325, ~1159 | verbatim |
| Far-shadow cache per genus × orientation for the current sun (`bakeLight`) | ~1052 | verbatim, rebaked when the sun moves |
| Real-time marcher: shared depth slices, overlap-correct compositing, empty skip, 3-step light march, two-lobe HG phase, multiple-scattering approximation | `fs`, ~485–618 | near field; inputs swapped to the Lighting hub |
| Original cumulus volume (`DENSITY_GZIP`, 432×304×328) | embedded | moved to a data file |
| Sky / atmosphere / ambient (Nishita, metres, `SUNE = 7`, CPU colours) | ~342–436, ~1008–1050 | **replaced** by the OpenWorld Lighting hub |
| Baked path-traced multiple scattering per instance (`msTex`), path tracer | ~620–800, ~1072 | **deferred**: does not scale beyond 64 instances |
| TAA, denoiser, bloom, auto exposure, lens, UI | ~798–970, ~1300+ | **not used**: OpenWorld has its own |

Units: CloudWorks uses metres in a local Y-up frame relative to the camera; a genus box is ±3.7×2.6×2.8 units times `TYPES.scale × size`. OpenWorld uses km, Earth-centred, with +Y toward the north pole. Each placed cloud gets a local tangent frame (east, up, north). Positions stay relative to the camera, because float32 world coordinates in metres lose sub-metre precision.

## The core problem: scale

CloudWorks holds at most 64 instances in a wrapped 32 km square. From 665 km the view reaches about 3,000 km to the horizon, which is on the order of 10^5–10^6 cumulus. The shapes carry over unchanged. Placement, level of detail (LOD) and ambient lighting are rebuilt as three tiers, chosen per sample by pixel footprint:

| Tier | Range (approx.) | Representation | Lighting |
|---|---|---|---|
| **C · far** | footprint > 1/4 of the cloud size | Statistical field: per-genus vertical profiles of covered fraction and mean extinction, precomputed from the atlas, × observed cover | Hub sun and sky irradiance, multiple-scattering octaves; shadows from the shared map |
| **B · mid** | clouds a few pixels or more | Jittered cells on a cube-mapped sphere grid; the GPU walks the cells along each ray and samples the atlas per cell (genus, scale, 45° orientation, mirror and variant from a hash) | Short light march + shared shadow map for cloud-on-cloud shadows |
| **A · near** | < ~40 km from the camera | CloudWorks' own instance marcher, with the 64 nearest clouds from the same placement | Full CloudWorks in-cloud lighting; sky and haze from the hub |

Tiers fade across a footprint band, and C must match B's **transmittance on average**, not its mean density. Thresholding mip-averaged density is what made the 2026-10-15 region test read as overcast. The statistics are measured from the generated volumes, so they follow any change made in CloudWorks.

## Placement from the observed day

The data is already baked:
- `coverage.webp`: 8K cover fraction, ~5 km.
- `properties.png`: 2048×1024 RGBA. R cover, G cloud-top height (0–16 km), B log optical depth, A ice fraction.
- `terrain.png`: ground elevation.

Per ~5 km cell, an ISCCP-style classifier picks the genus. It uses cloud-top height × optical depth, plus cover and ice; OpenWorld's existing `cloudWeather` classifier is the starting point. The mapping is:

| ISCCP class | Genus |
|---|---|
| low, thin, broken | Cu |
| low, broken → overcast | Sc |
| low, uniform | St |
| low/mid, thick | Ns |
| mid, thin / cellular | Ac |
| mid, uniform | As |
| deep convection | Cb |
| high, thin | Ci |
| high, uniform veil | Cs |
| high, cellular | Cc |

Measured optical depth scales each genus's density. Cloud bases follow the terrain. Data loading moves out of the disabled built-in path into the provider.

## Code layout and sync

- **In CloudWorks:** factor the reusable parts into `CloudWorks/src/cloudcore.js`, an ES module with no DOM access. It exports `TYPES`, `TYPE_ORDER`, `makeLobes`, the GLSL chunks (`common`, `genFs`, `occFs`, bake, marcher core) and a `createCloudAtlas(gl)` that generates the volumes. `template.html` / `build.py` inline it, so Groundview behaves exactly as before.
  - CloudWorks has uncommitted work (`template.html` +512 lines). Commit it before the refactor.
- **In OpenWorld:**
  - `build.js` takes `cloudcore.js` from `../CloudWorks/src/` (path configurable).
  - A new provider `src/cwclouds.js` builds tiers A–C on top of it.
  - The original cumulus volume moves to `data/cloudworks/legacy-cumulus.bin`.
- **The Lighting hub stays the only sky:** CloudWorks code takes `sunTransmittance`, `skyIrradiance` and `aerial` through injected GLSL functions. The two apps share shapes, not skies.

## Phases (each ends with a visible, checked result)

1. **Shared core + atlas in OpenWorld.**
   - Extract `cloudcore.js`, and check that Groundview is unchanged (its node tests plus a side-by-side render).
   - Generate the atlas inside the provider. Add a debug line-up of all ten genera in free flight, matched against Groundview with the same seed and sun.
2. **Orbit view: far field (C) + placement.**
   - Classifier → genus per cell, and per-genus statistics measured from the atlas.
   - The orbit view over the Ionian Sea and other `PLACES` is compared with the VIIRS true-colour image of the same day. The shared shadow map is written for ground, sea and spacecraft.
3. **Mid field (B).** Cell traversal with the atlas; B↔C crossfade without a visible change in cover; the big genera (Cb anvils, layer decks) resolve from orbit.
4. **Near field (A).**
   - CloudWorks' marcher inside the slot, plus temporal accumulation added to the slot itself (reprojection with provider depth).
   - Brightness recalibrated so a cloud matches Groundview under OpenWorld's exposure.
5. **Performance and polish.** Target at most 6 ms GPU at 1440p from orbit (RTX 3060 reference, timer queries). Sun-dependent bakes are amortised over frames. Flight-plan downloads are unaffected.

## Verification

- Each phase is checked with numeric A/B where possible: timer queries, pixel statistics, and the shape-audit metrics from `shape-audit.js`.
- Side-by-side screenshots against Groundview for shapes and lighting, and against the VIIRS image for placement.
- No-provider OpenWorld must stay pixel-identical (as on 2026-10-15).

## Risks and open points

- **Uniform and texture budgets:** atlas depth is `FD × 10 ≤ MAX_3D_TEXTURE_SIZE`; the cell traversal needs care at cube-face seams.
- **Far-shadow cache:** it is baked for one sun direction. Time warp can move the sun faster than a bake, so the bake is incremental and the shadows lag slightly.
- **Brightness:** CloudWorks was tuned with its own exposure and `SUNE = 7`; recalibration must not change the look.
- **Observed-day realism:** the classifier and the per-genus density scale need tuning by eye against the VIIRS image.
- **Out of scope for now:** cloud evolution or advection beyond static placement, rain, scene depth for clouds behind mountains, and the path tracer.
