"""Bake the cloud library's procedural volumes into density grids for the web renderer.

The density functions are the ones in cloud_library.py, unchanged: their node graphs are
rebuilt as Geometry Nodes (same Noise / Voronoi / Map Range / Float Curve nodes, so the field
is identical to what Cycles renders), evaluated on a voxel grid and written out.

  heaps  (cumulus humilis / mediocris / congestus, cumulonimbus): several seeds each, the
         box's object space [-1, 1]^3 sampled on a 96 x 96 x 64 grid; the renderer stretches
         the unit box to each cloud's real size.
  layers (stratocumulus ... cirrostratus): one horizontally TILEABLE patch per type, 48 km
         square, the full layer depth.

Output (data/clouds/models/): <name>.png per model, the z-slices tiled left-to-right,
top-to-bottom in an 8-column grid, 8-bit density normalised by the model's maximum, and
manifest.json with sizes, heights, extinction and the normalisation.

Run:  blender -b -P bake_volumes.py -- [--only cumulus_humilis,cirrus] [--quick]
"""
import bpy, os, sys, json, math, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "data", "clouds", "models")
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ONLY = None
for i, a in enumerate(argv):
    if a == "--only":
        ONLY = set(argv[i + 1].split(","))
QUICK = "--quick" in argv

# ---- load the library's builders (everything above its "main" section) ------------------------
src = open(os.path.join(HERE, "cloud_library.py"), encoding="utf-8").read()
src = src[:src.index("# =========================================================== main")]
saved_argv = sys.argv
sys.argv = [sys.argv[0]]           # keep the library's own flag parsing quiet
lib = {"__file__": os.path.join(HERE, "cloud_library.py"), "__name__": "cloud_library"}
exec(compile(src, "cloud_library.py", "exec"), lib)
sys.argv = saved_argv


class _Out:
    def __init__(self, outputs): self.outputs = outputs


class GN(lib["G"]):
    """The library's graph builder, emitting into a Geometry Nodes tree. Object-space texture
    coordinates become the point position; Object Info > Random becomes the variant seed."""

    def __init__(self, tree, seed):
        super().__init__(tree)
        self.tree = tree
        self.pos = self.N.new("GeometryNodeInputPosition").outputs[0]
        v = self.N.new("ShaderNodeValue")
        v.outputs[0].default_value = seed
        self.rand = v.outputs[0]

    def new(self, t, **props):
        if t == "ShaderNodeTexCoord":
            return _Out({"Object": self.pos})
        if t == "ShaderNodeObjectInfo":
            return _Out({"Random": self.rand})
        return super().new(t, **props)


STATE = {"seed": 0.0, "meta": None}


def new_material(name):
    tree = bpy.data.node_groups.new(name, "GeometryNodeTree")
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    return tree, GN(tree, STATE["seed"])


def finish_volume(g, dens, density, phase):
    """Instead of a volume shader: store the 0..1 density field on the points."""
    gin = g.N.new("NodeGroupInput")
    gout = g.N.new("NodeGroupOutput")
    st = g.N.new("GeometryNodeStoreNamedAttribute")
    st.data_type = "FLOAT"
    st.domain = "POINT"
    st.inputs["Name"].default_value = "density"
    g.L.new(gin.outputs[0], st.inputs["Geometry"])
    g.put(dens, st.inputs["Value"])
    g.L.new(st.outputs[0], gout.inputs[0])
    STATE["meta"] = {"extinctionPerKm": density * 1000.0, "phase": phase}


lib["new_material"] = new_material
lib["finish_volume"] = finish_volume
heap_material = lib["heap_material"]
_layer_material = lib["layer_material"]


def layer_material(*a, **kw):
    """Bake a layer's continuous pattern instead of its thresholded density: the library's final
    remap(s, 1 - coverage, 1 - coverage + soft) is widened to cover the whole range of s
    (about -0.7 .. 1.15), so it stays a monotonic function of s. The renderer re-applies the
    threshold from the observed cover (see the 'q' quantiles in the manifest)."""
    STATE["layer"] = {"coverage": kw.get("coverage", 0.6), "soft": kw.get("soft", 0.12)}
    kw["coverage"], kw["soft"] = 1.8, 2.2
    return _layer_material(*a, **kw)
WATER, CUMULUS_PROFILE, TOWER_PROFILE = lib["WATER"], lib["CUMULUS_PROFILE"], lib["TOWER_PROFILE"]

# ---- the catalogue: same parameters as cloud_library.py's build_* functions ----------------------
# heaps: unit-box material + real-world placement statistics (half sizes in metres)
HEAPS = {
    "cumulus_humilis": dict(mat=lambda: heap_material("h", WATER, [(0, 0.75), (0.3, 0.72), (0.7, 0.45), (1, 0.08)], billow_scale=2.6),
                            base=1200, half=(450, 1000), tall=(0.3, 0.45), seeds=6),
    "cumulus_mediocris": dict(mat=lambda: heap_material("m", WATER, CUMULUS_PROFILE),
                              base=1400, half=(500, 1300), tall=(0.45, 0.7), seeds=6),
    "cumulus_congestus": dict(mat=lambda: heap_material("c", WATER * 1.2, TOWER_PROFILE, warp=0.55, edge=0.05, billow_scale=2.2),
                              base=1300, half=(1600, 2400), tall=(0.8, 1.35), seeds=6),
    "cumulonimbus": dict(mat=lambda: heap_material("cb", WATER * 1.3,
                                                   [(0, 0.34), (0.3, 0.33), (0.55, 0.3), (0.7, 0.36), (0.8, 0.55), (0.88, 0.62), (0.95, 0.55), (1, 0.3)],
                                                   warp=0.3, top=(0.95, 0.86), anvil=True, edge=0.05, billow_scale=2.6, turrets=0, shear=0.35),
                         base=1200, half=(10000, 16000), tall=(0.47, 0.47), seeds=4, box=(16000, 10000, 7500)),
}
# layers: (half box size in m as in the library, material, base height in m)
LAYERS = {
    "stratocumulus": ((90000, 90000, 300), lambda h: layer_material("sc", h, WATER * 0.7, "cells", cell=0.8, stretch=(0.6, 1.0), coverage=0.8, soft=0.14, fade=(0.3, 0.6)), 1100),
    "stratus": ((120000, 120000, 250), lambda h: layer_material("st", h, WATER * 0.35, "uniform", cell=0.25, coverage=0.92, soft=0.25, fade=(0.5, 0.4), rough_base=0.6, regional=(0.2, 0.5)), 450),
    "nimbostratus": ((120000, 120000, 1600), lambda h: layer_material("ns", h, 0.0035, "uniform", cell=0.35, coverage=0.97, soft=0.2, fade=(0.25, 0.3), rough_base=0.25, regional=(0.1, 0.4)), 700),
    "altocumulus": ((90000, 90000, 160), lambda h: layer_material("ac", h, WATER * 0.6, "mackerel", cell=1.6, coverage=0.62, soft=0.16, fade=(0.45, 0.6), rough_base=0.4), 4200),
    "altostratus": ((120000, 120000, 600), lambda h: layer_material("as", h, 0.0035, "uniform", cell=0.2, coverage=0.95, soft=0.35, fade=(0.5, 0.5), rough_base=0.2, regional=(0.25, 0.6)), 4500),
    "cirrus": ((150000, 150000, 700), lambda h: layer_material("ci", h, 0.004, "streaks", phase="ice", cell=0.3, coverage=0.78, soft=0.3, fade=(0.6, 0.6), rough_base=0.6, regional=(0.35, 0.7)), 9000),
    "cirrocumulus": ((120000, 120000, 120), lambda h: layer_material("cc", h, 0.02, "cells", phase="ice", cell=6.0, stretch=(0.5, 1.0), coverage=0.6, soft=0.12, fade=(0.5, 0.5), rough_base=0.2, regional=(0.4, 0.7)), 8000),
    "cirrostratus": ((150000, 150000, 800), lambda h: layer_material("cs", h, 0.0009, "uniform", phase="ice", cell=0.15, coverage=0.9, soft=0.4, fade=(0.6, 0.6), rough_base=0.3, regional=(0.3, 0.7)), 8500),
}
HEAP_RES = (48, 48, 32) if QUICK else (96, 96, 64)
LAYER_RES = (64, 64, 8) if QUICK else (256, 256, 24)
TILE_KM = 48.0
BLEND = 0.25        # share of the tile cross-faded to make it seamless


def evaluate(tree, pts):
    """Evaluate the stored 'density' of a Geometry Nodes tree at the given object-space points."""
    me = bpy.data.meshes.new("grid")
    me.vertices.add(len(pts))
    me.vertices.foreach_set("co", pts.astype(np.float32).ravel())
    ob = bpy.data.objects.new("grid", me)
    bpy.context.scene.collection.objects.link(ob)
    mod = ob.modifiers.new("bake", "NODES")
    mod.node_group = tree
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    out = np.empty(len(pts), np.float32)
    ev.data.attributes["density"].data.foreach_get("value", out)
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(me)
    return np.maximum(out, 0.0)


def grid(nx, ny, nz, x0, x1, y0, y1, z0=-1.0, z1=1.0):
    xs = x0 + (np.arange(nx) + 0.5) / nx * (x1 - x0)
    ys = y0 + (np.arange(ny) + 0.5) / ny * (y1 - y0)
    zs = z0 + (np.arange(nz) + 0.5) / nz * (z1 - z0)
    Z, Y, X = np.meshgrid(zs, ys, xs, indexing="ij")
    return np.stack([X.ravel(), Y.ravel(), Z.ravel()], 1)      # z-major order: [z][y][x]


def save(name, vol):
    """vol: [z][y][x] float -> 8-bit slice atlas (8 columns)."""
    nz, ny, nx = vol.shape
    peak = float(vol.max()) or 1.0
    q = np.clip(np.round(vol / peak * 255.0), 0, 255).astype(np.uint8)
    cols = 8
    rows = math.ceil(nz / cols)
    img = np.zeros((rows * ny, cols * nx), np.uint8)
    for k in range(nz):
        r, c = divmod(k, cols)
        img[r * ny:(r + 1) * ny, c * nx:(c + 1) * nx] = q[k]
    # Blender image API: bottom-up rows, RGBA floats
    h, w = img.shape
    bimg = bpy.data.images.new(name, w, h, alpha=False)
    rgba = np.repeat((img[::-1].astype(np.float32) / 255.0)[..., None], 4, axis=2)
    rgba[..., 3] = 1.0
    bimg.pixels.foreach_set(rgba.ravel())
    bimg.filepath_raw = os.path.join(OUT, name + ".png")
    bimg.file_format = "PNG"
    bimg.save()
    bpy.data.images.remove(bimg)
    return peak, float(vol.mean())


def main():
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    man_path = os.path.join(OUT, "manifest.json")
    manifest = json.load(open(man_path)) if (ONLY and os.path.exists(man_path)) else {"heaps": {}, "layers": {}}
    t_all = time.time()

    for key, h in HEAPS.items():
        if ONLY and key not in ONLY:
            continue
        variants = []
        for s in range(h["seeds"]):
            t = time.time()
            STATE["seed"] = 0.137 + 0.618034 * s % 1.0
            tree = h["mat"]()
            vol = evaluate(tree, grid(*HEAP_RES, -1, 1, -1, 1)).reshape(HEAP_RES[2], HEAP_RES[1], HEAP_RES[0])
            bpy.data.node_groups.remove(tree)
            name = f"{key}_{s}"
            peak, mean = save(name, vol)
            variants.append({"file": name + ".png", "peak": peak, "fill": float((vol > 0.02 * peak).mean())})
            print(f"BAKED {name} {vol.shape} peak {peak:.3f} in {time.time() - t:.1f}s", flush=True)
        manifest["heaps"][key] = {
            "res": list(HEAP_RES), "variants": variants, "baseM": h["base"], "halfM": list(h["half"]),
            "tall": list(h["tall"]), "box": list(h.get("box", ())), **STATE["meta"],
        }

    for key, (half, mk, base) in LAYERS.items():
        if ONLY and key not in ONLY:
            continue
        t = time.time()
        STATE["seed"] = 0.37
        tree = mk(half)
        nx, ny, nz = LAYER_RES
        # sample a (1 + BLEND) tile and cross-fade the overlap onto the opposite edge -> seamless
        ext = TILE_KM * (1 + BLEND)
        hx, hy = half[0] / 1000.0, half[1] / 1000.0          # km per object-space unit
        mx, my = int(round(nx * (1 + BLEND))), int(round(ny * (1 + BLEND)))
        vol = evaluate(tree, grid(mx, my, nz, -ext / 2 / hx, ext / 2 / hx, -ext / 2 / hy, ext / 2 / hy)).reshape(nz, my, mx)
        bpy.data.node_groups.remove(tree)
        ox, oy = mx - nx, my - ny
        w = np.linspace(0, 1, ox, endpoint=False)[None, None, :]
        tile = vol[:, :, :nx].copy()
        tile[:, :, :ox] = tile[:, :, :ox] * w + vol[:, :, nx:] * (1 - w)
        tile2 = tile[:, :ny, :].copy()
        wy = np.linspace(0, 1, oy, endpoint=False)[None, :, None]
        tile2[:, :oy, :] = tile2[:, :oy, :] * wy + tile[:, ny:, :] * (1 - wy)
        peak, mean = save(key, tile2)
        pot = tile2 / peak
        # cover -> threshold: quantiles of each column's maximum (the fraction of sky it covers)
        colmax = pot.max(axis=0).ravel()
        q = np.quantile(colmax, np.linspace(0.0, 1.0, 33)).tolist()
        # the library's own threshold and soft width, in the same normalised units
        ss = lambda v: (lambda t: t * t * t * (t * (t * 6 - 15) + 10))(min(max((v + 0.8) / 2.2, 0.0), 1.0)) / peak
        thr0 = 1.0 - STATE["layer"]["coverage"]
        manifest["layers"][key] = {
            "file": key + ".png", "res": list(LAYER_RES), "tileKm": TILE_KM, "baseM": base,
            "thickM": 2 * half[2], "peak": peak, "q": q, "thr": ss(thr0), "soft": ss(thr0 + STATE["layer"]["soft"]) - ss(thr0),
            "coverage": STATE["layer"]["coverage"], **STATE["meta"],
        }
        print(f"BAKED {key} {tile2.shape} peak {peak:.3f} in {time.time() - t:.1f}s", flush=True)

    json.dump(manifest, open(man_path, "w"), indent=1)
    print(f"DONE in {time.time() - t_all:.0f}s -> {OUT}", flush=True)


main()
