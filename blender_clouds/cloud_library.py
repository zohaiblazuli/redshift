"""Library of realistic procedural volumetric clouds for Blender 5.x (Cycles).

One Blender scene per cloud type (the 10 WMO genera + cumulus variants), each
with its own sky, sun, ground and camera framed for that cloud.

Run:
  blender -b -P cloud_library.py                         # build cloud_library.blend
  blender -b -P cloud_library.py -- --render             # + render every scene (fast)
  blender -b -P cloud_library.py -- --render --only cirrus,stratus --res 50
  add --fast for quick low-bounce previews; --samples N to change quality

Reference values (WMO Cloud Atlas, lidar studies):
  low  clouds: base < 2 km     water droplets, extinction ~0.035-0.06 /m
  mid  clouds: base 2-7 km     water / mixed
  high clouds: base > 5 km     ice crystals, extinction ~0.0001-0.0005 /m
"""
import bpy, math, random, sys, os
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
RENDER = "--render" in argv
FAST = "--fast" in argv
SAMPLES = 16
TIME_LIMIT = 90.0
ONLY = None
RES = 100
for i, a in enumerate(argv):
    if a == "--only":
        ONLY = set(argv[i + 1].split(","))
    if a == "--samples":
        SAMPLES = int(argv[i + 1])
    if a == "--res":
        RES = int(argv[i + 1])
# fast mode uses fewer volume bounces; thinner water clouds keep them bright
DENSITY_SCALE = 0.5 if FAST else 1.0
VOL_BOUNCES = 24


# =========================================================== node helpers
class G:
    """Tiny shader-graph builder: values can be sockets or constants."""

    def __init__(self, nt):
        self.N, self.L = nt.nodes, nt.links

    def put(self, val, socket):
        if hasattr(val, "is_linked"):
            self.L.new(val, socket)
        else:
            socket.default_value = val

    def new(self, t, **props):
        n = self.N.new(t)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def math(self, op, a, b=None, clamp=False):
        n = self.new("ShaderNodeMath", operation=op, use_clamp=clamp)
        self.put(a, n.inputs[0])
        if b is not None:
            self.put(b, n.inputs[1])
        return n.outputs[0]

    def add(self, a, b): return self.math("ADD", a, b)
    def sub(self, a, b): return self.math("SUBTRACT", a, b)
    def mul(self, a, b): return self.math("MULTIPLY", a, b)

    def vmath(self, op, a, b):
        n = self.new("ShaderNodeVectorMath", operation=op)
        self.put(a, n.inputs[0])
        self.put(b, n.inputs[1])
        return n.outputs["Value" if op in ("LENGTH", "DOT_PRODUCT") else "Vector"]

    def length(self, a):
        n = self.new("ShaderNodeVectorMath", operation="LENGTH")
        self.put(a, n.inputs[0])
        return n.outputs["Value"]

    def remap(self, x, a, b, c=0.0, d=1.0, interp="SMOOTHSTEP"):
        n = self.new("ShaderNodeMapRange", interpolation_type=interp, clamp=True)
        self.put(x, n.inputs["Value"])
        for k, v in (("From Min", a), ("From Max", b), ("To Min", c), ("To Max", d)):
            self.put(v, n.inputs[k])
        return n.outputs["Result"]

    def noise(self, vec, scale, detail=2.0, rough=0.5, out="Fac"):
        n = self.new("ShaderNodeTexNoise")
        self.put(vec, n.inputs["Vector"])
        n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = detail
        n.inputs["Roughness"].default_value = rough
        return n.outputs[out]

    def voronoi(self, vec, scale, rand=1.0):
        n = self.new("ShaderNodeTexVoronoi", feature="F1", distance="EUCLIDEAN")
        self.put(vec, n.inputs["Vector"])
        n.inputs["Scale"].default_value = scale
        n.inputs["Randomness"].default_value = rand
        return n.outputs["Distance"]

    def xyz(self, v):
        n = self.new("ShaderNodeSeparateXYZ")
        self.put(v, n.inputs[0])
        return n.outputs["X"], n.outputs["Y"], n.outputs["Z"]

    def combine(self, x, y, z):
        n = self.new("ShaderNodeCombineXYZ")
        for s, v in zip(n.inputs, (x, y, z)):
            self.put(v, s)
        return n.outputs[0]

    def curve(self, x, pts):
        n = self.new("ShaderNodeFloatCurve")
        cp = n.mapping.curves[0].points
        cp[0].location, cp[1].location = pts[0], pts[-1]
        for p in pts[1:-1]:
            cp.new(*p)
        n.mapping.update()
        self.put(x, n.inputs["Value"])
        return n.outputs[0]


def finish_volume(g, dens, density, phase):
    """dens (0..1 socket) * density -> scatter-only volume with a physical phase function."""
    val = g.new("ShaderNodeValue", name="Cloud Density", label="Cloud Density")
    val.outputs[0].default_value = density
    vol = g.new("ShaderNodeVolumeScatter")
    vol.inputs["Color"].default_value = (1, 1, 1, 1)
    if phase == "ice":
        # ice crystals: strongly forward-scattering, approximated with Henyey-Greenstein
        vol.phase = "HENYEY_GREENSTEIN"
        vol.inputs["Anisotropy"].default_value = 0.75
    else:
        # water droplets ~20 um: Mie gives the real cloud glory / silver lining
        vol.phase = "MIE"
        vol.inputs["Diameter"].default_value = 20.0
    g.put(g.mul(dens, val.outputs[0]), vol.inputs["Density"])
    out = g.new("ShaderNodeOutputMaterial")
    g.L.new(vol.outputs[0], out.inputs["Volume"])


def new_material(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes.clear()
    return m, G(m.node_tree)


# =========================================================== cumuliform (heaps / towers)
def heap_material(name, density, profile, billows=None, warp=0.75, fine=0.14,
                  top=(0.95, 0.55), anvil=False, edge=0.035, billow_scale=2.4, turrets=3, shear=0.0):
    """One convective turret in a cube domain (object space [-1, 1]). Clouds are built
    from several overlapping turrets, so densities add up into a cauliflower cluster.
    profile: (height 0..1, horizontal radius) points of the envelope."""
    m, g = new_material(name)
    tc = g.new("ShaderNodeTexCoord")
    oi = g.new("ShaderNodeObjectInfo")
    P = tc.outputs["Object"]
    Ps = g.vmath("ADD", P, g.vmath("MULTIPLY", oi.outputs["Random"], (137.0, 71.0, 213.0)))

    # large-scale domain warp -> irregular, leaning silhouette
    w = g.noise(Ps, 1.1, 3.0, 0.5, out="Color")
    w = g.vmath("MULTIPLY", g.vmath("SUBTRACT", w, (0.5, 0.5, 0.5)), (warp, warp, warp * 0.6))
    Pw = g.vmath("ADD", P, w)
    x, y, z = g.xyz(Pw)
    h = g.remap(z, -0.55, 0.85, 0, 1, "LINEAR")
    if shear:
        # upper-level wind drags the anvil downwind (+X)
        x = g.sub(x, g.mul(g.remap(h, 0.6, 1.0), shear))
    rad = g.curve(h, profile)
    base = g.sub(rad, g.length(g.combine(x, y, 0.0)))
    base = g.sub(base, g.mul(g.sub(1.0, g.remap(z, top[0], top[1])), 0.6))
    # extra turrets: rising thermals of random position / height / width, all inside this
    # one volume (overlapping volume objects are very slow with null-scattering)
    for i in range(int(os.environ.get("TURRETS", turrets))):
        rv = g.noise(g.vmath("ADD", g.vmath("MULTIPLY", oi.outputs["Random"], (91.7, 53.3, 17.9)),
                             (i * 7.31, i * 3.17, i * 5.53)), 1.0, 0.0, 0.5, out="Color")
        rx, ry, rz = g.xyz(rv)
        cx = g.mul(g.sub(rx, 0.5), 1.3)
        cy = g.mul(g.sub(ry, 0.5), 1.3)
        t = g.remap(rz, 0.3, 0.7, 0.35, 1.0, "LINEAR")           # relative turret height
        hr = g.math("DIVIDE", g.add(z, 0.55), g.mul(t, 1.4))       # unclamped height 0..1
        r_i = g.mul(g.curve(g.math("MINIMUM", hr, 1.0), profile), g.remap(rx, 0.0, 1.0, 0.45, 0.7))
        d_i = g.sub(r_i, g.length(g.combine(g.sub(x, cx), g.sub(y, cy), 0.0)))
        d_i = g.sub(d_i, g.mul(g.remap(hr, 0.88, 1.05), 0.8))       # rounded turret top
        base = g.math("MAXIMUM", base, d_i)

    # cauliflower: fractal Smooth-F1 Worley gives merged round sub-billows on every scale
    def puffs(scale, detail, amp, smooth=0.6):
        n = g.new("ShaderNodeTexVoronoi", feature="F1", distance="EUCLIDEAN")
        g.put(Ps, n.inputs["Vector"])
        for k, v in (("Scale", scale), ("Detail", detail), ("Roughness", 0.55),
                     ("Lacunarity", 2.2), ("Smoothness", smooth), ("Randomness", 1.0)):
            if k in n.inputs:
                n.inputs[k].default_value = v
        return g.mul(g.sub(0.5, n.outputs["Distance"]), amp)

    # four octaves of inverted Worley: big lobes -> cauliflower knobs -> fine curd
    b = puffs(billow_scale, 0.0, 0.55)
    for mult, amp in ((2.3, 0.28), (5.0, 0.13), (11.0, 0.06)):
        b = g.add(b, puffs(billow_scale * mult, 0.0, amp))
    # billows are crisp on the sunlit upper dome, subdued at the base
    b = g.mul(b, g.remap(h, 0.0, 0.55, 0.4, 1.0))
    d = g.add(base, b)

    # high-frequency erosion: wispy, torn edges mostly near the base and sides
    ero = g.sub(g.noise(Ps, 38.0, 3.0, 0.62), 0.5)
    d = g.add(d, g.mul(ero, g.add(fine, g.remap(h, 0.0, 0.3, fine * 1.5, 0.0))))

    if anvil:
        # glaciated anvil: smooth, fibrous, spreading under the tropopause
        q = g.vmath("MULTIPLY", Ps, (1.5, 1.5, 9.0))
        fib = g.mul(g.sub(g.noise(q, 2.5, 8.0, 0.65), 0.5), 0.5)
        d = g.add(d, g.mul(fib, g.remap(h, 0.72, 0.86)))
        # smooth the anvil: glaciated cloud loses the cauliflower texture
        d = g.sub(d, g.mul(b, g.remap(h, 0.74, 0.86, 0.0, 0.65)))

    _, _, z0 = g.xyz(P)
    d = g.mul(d, g.remap(z0, -0.6, -0.53))            # flat condensation base
    dens = g.remap(d, 0.0, edge, 0, 1, "SMOOTHERSTEP")
    # denser core: optical depth grows inward, which gives the dark-cored, bright-rimmed look
    dens = g.mul(dens, g.remap(d, 0.0, 0.35, 0.55, 1.4, "LINEAR"))
    dens = g.mul(dens, g.remap(h, 0.0, 0.25, 0.6, 1.0))
    if anvil:
        dens = g.mul(dens, g.remap(h, 0.74, 0.9, 1.0, 0.35))   # thinner ice anvil
    finish_volume(g, dens, density, "water")
    return m


# =========================================================== stratiform layers
def layer_material(name, half, density, kind, phase="water", cell=1.0, stretch=(1, 1),
                   coverage=0.6, soft=0.12, fade=(0.35, 0.35), rough_base=0.3,
                   regional=(0.35, 0.65)):
    """Cloud sheet filling a flat box. half = box half-size in metres (x, y, z).
    Pattern coordinates are in km so `cell` reads as features per km."""
    m, g = new_material(name)
    tc = g.new("ShaderNodeTexCoord")
    oi = g.new("ShaderNodeObjectInfo")
    P = tc.outputs["Object"]
    Pk = g.vmath("MULTIPLY", P, (half[0] / 1000, half[1] / 1000, half[2] / 1000))
    Pk = g.vmath("ADD", Pk, g.vmath("MULTIPLY", oi.outputs["Random"], (57.0, 91.0, 0.0)))
    _, _, zl = g.xyz(P)

    # horizontal domain warp keeps every pattern organic
    w = g.noise(g.vmath("MULTIPLY", Pk, (0.35, 0.35, 0.35)), 1.0, 3.0, 0.5, out="Color")
    w = g.vmath("MULTIPLY", g.vmath("SUBTRACT", w, (0.5, 0.5, 0.5)), (2.4 / cell, 2.4 / cell, 0.0))
    Pw = g.vmath("ADD", Pk, w)
    Pc = g.vmath("MULTIPLY", Pw, (cell * stretch[0], cell * stretch[1], cell))

    if kind == "cells":                       # stratocumulus / altocumulus / cirrocumulus
        c = g.remap(g.voronoi(Pc, 1.0), 0.8, 0.12)
        fbm = g.noise(Pc, 3.0, 6.0, 0.55)
        p = g.add(g.mul(c, 0.58), g.mul(fbm, 0.42))
        if stretch != (1, 1):
            # billow rows: modulate with waves perpendicular to the stretch
            px, py, _ = g.xyz(Pc)
            wave = g.math("SINE", g.mul(py, 2.0 * math.pi))
            p = g.mul(p, g.remap(wave, -1.0, 1.0, 0.75, 1.0))
    elif kind == "streaks":                   # cirrus: fibrous ice trails
        # gentle large-scale curvature of the jet-stream wind field
        bend = g.noise(g.vmath("MULTIPLY", Pk, (0.04, 0.04, 0.0)), 1.0, 1.0, 0.5, out="Color")
        Pb = g.vmath("ADD", Pk, g.vmath("MULTIPLY", g.vmath("SUBTRACT", bend, (0.5, 0.5, 0.5)), (0.0, 9.0, 0.0)))
        # elongated patches (km wide, tens of km long) where ice is falling out
        band = g.remap(g.noise(g.vmath("MULTIPLY", Pb, (0.025, 0.22, 0.0)), 1.0, 3.0, 0.55), 0.42, 0.6)
        # fine combed striations along the wind; strong anisotropy = hair-like fibres
        fib = g.noise(g.vmath("MULTIPLY", Pb, (0.06, 3.2, 0.5)), 1.0, 5.0, 0.6)
        fib = g.remap(fib, 0.38, 0.72)
        # tufts / hooks: denser heads where the crystals formed, fading into trails
        head = g.remap(g.noise(g.vmath("MULTIPLY", Pb, (0.18, 0.5, 0.0)), 1.0, 2.0, 0.5), 0.5, 0.75, 0.55, 1.0)
        p = g.mul(g.mul(band, g.add(0.25, g.mul(fib, 0.75))), head)
    elif kind == "mackerel":                  # altocumulus: merged cells of mixed size in rows
        big = g.remap(g.voronoi(Pc, 1.0), 0.85, 0.15)
        small = g.remap(g.voronoi(Pc, 2.3), 0.8, 0.15)
        cellmix = g.math("MAXIMUM", big, g.mul(small, 0.85))
        px, py, _ = g.xyz(Pc)
        rows = g.math("SINE", g.add(g.mul(py, 2.2), g.mul(g.noise(Pc, 0.4, 2.0, 0.5), 6.0)))
        p = g.add(g.mul(cellmix, 0.55), g.mul(g.noise(Pc, 2.5, 5.0, 0.55), 0.3))
        p = g.mul(p, g.remap(rows, -1.0, 1.0, 0.7, 1.08))
    else:                                     # uniform: stratus / altostratus / nimbostratus / cirrostratus
        p = g.noise(Pc, 1.0, 8.0, 0.5)

    # regional coverage: holes and thicker patches over tens of km
    reg = g.noise(g.vmath("MULTIPLY", Pk, (0.05, 0.05, 0.05)), 1.0, 2.0, 0.5)
    p = g.mul(p, g.remap(reg, regional[0], regional[1], 0.55, 1.15))

    # vertical profile with an undulating base / top
    und = g.mul(g.sub(g.noise(g.vmath("MULTIPLY", Pk, (0.6, 0.6, 0.0)), 1.0, 4.0, 0.55), 0.5), rough_base)
    zt = g.add(zl, und)
    vp = g.mul(g.remap(zt, -1.0, -1.0 + fade[0]), g.remap(zt, 1.0, 1.0 - fade[1]))
    s = g.sub(p, g.mul(g.sub(1.0, vp), 0.7))
    thr = 1.0 - coverage
    dens = g.remap(s, thr, thr + soft, 0, 1, "SMOOTHERSTEP")
    finish_volume(g, dens, density, phase)
    return m


# =========================================================== scene scaffolding
def setup_scene(name, sun_elev, sun_az, sun_power=14.0, sky_strength=0.22):
    scene = bpy.data.scenes.new(name)
    scene.render.engine = "CYCLES"
    cy = scene.cycles
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "OPTIX"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == "OPTIX"
        cy.device = "GPU"
    except Exception:
        cy.device = "CPU"
    cy.use_denoising = True
    cy.time_limit = TIME_LIMIT   # hard cap per image; denoiser cleans whatever samples fit
    cy.denoiser = "OPTIX"
    cy.caustics_reflective = cy.caustics_refractive = False
    cy.sample_clamp_indirect = 20.0
    cy.diffuse_bounces = cy.glossy_bounces = 4
    cy.transparent_max_bounces = 16
    cy.volume_max_steps = 1024
    if FAST:
        cy.samples, cy.volume_bounces, cy.max_bounces = 16, 12, 16
    else:
        # multiple scattering is where cloud brightness and softness come from
        cy.samples, cy.volume_bounces, cy.max_bounces = SAMPLES, VOL_BOUNCES, VOL_BOUNCES + 16
    scene.render.resolution_x, scene.render.resolution_y = 960, 540
    scene.render.resolution_percentage = RES
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Punchy"

    world = bpy.data.worlds.new(name + "_Sky")
    scene.world = world
    world.use_nodes = True
    wg = G(world.node_tree)
    wg.N.clear()
    sky = wg.new("ShaderNodeTexSky", sky_type="MULTIPLE_SCATTERING", sun_disc=False,
                 sun_elevation=math.radians(sun_elev), sun_rotation=math.radians(sun_az))
    sky.altitude = 300.0
    bg = wg.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = sky_strength
    out = wg.new("ShaderNodeOutputWorld")
    wg.L.new(sky.outputs[0], bg.inputs[0])
    wg.L.new(bg.outputs[0], out.inputs[0])

    el, az = math.radians(sun_elev), math.radians(sun_az)
    sun_dir = Vector((-math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el)))
    ld = bpy.data.lights.new(name + "_Sun", "SUN")
    ld.energy = sun_power
    ld.angle = math.radians(0.53)
    ld.color = (1.0, 0.95, 0.88) if sun_elev > 15 else (1.0, 0.8, 0.6)
    sun = bpy.data.objects.new(name + "_Sun", ld)
    sun.rotation_euler = (-sun_dir).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(sun)

    scene.collection.objects.link(GROUND)
    if "--atmos" in argv:   # physical aerial perspective: realistic but grainy at low samples
        scene.collection.objects.link(ATMOSPHERE)
    return scene


def make_terrain():
    """Rolling farmland / forest hills, flat near the cameras, haze handled by ATMOSPHERE."""
    from mathutils import noise
    n, size = 360, 160000.0
    verts, faces = [], []
    for j in range(n + 1):
        for i in range(n + 1):
            x = -size / 2 + size * i / n
            y = -size / 2 + size * j / n + 50000
            r = math.hypot(x, y + 3000)
            k = min(1.0, max(0.0, (r - 3000) / 9000)) ** 2
            h = noise.fractal(Vector((x / 9000, y / 9000, 0.0)), 0.6, 2.1, 6) * 260 + 120
            h += max(0.0, noise.noise(Vector((x / 30000, y / 30000, 3.0)))) * 450   # distant ridges
            verts.append((x, y, max(0.0, h) * k))
    for j in range(n):
        for i in range(n):
            a = j * (n + 1) + i
            faces.append((a, a + 1, a + n + 2, a + n + 1))
    me = bpy.data.meshes.new("Terrain")
    me.from_pydata(verts, [], faces)
    me.shade_smooth()
    ob = bpy.data.objects.new("Terrain", me)

    m, g = new_material("Terrain")
    bsdf = g.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.92
    bsdf.inputs["Specular IOR Level"].default_value = 0.1
    co = g.new("ShaderNodeTexCoord").outputs["Object"]
    ramp = g.new("ShaderNodeValToRGB")
    els = ramp.color_ramp.elements
    els[0].color, els[1].color = (0.02, 0.024, 0.014, 1), (0.085, 0.075, 0.05, 1)   # forest -> dry field
    e = els.new(0.5)
    e.color = (0.042, 0.05, 0.026, 1)                                              # pasture
    fields = g.voronoi(co, 0.0012, 0.9)                                           # field patchwork
    patch = g.add(g.mul(g.noise(co, 0.0002, 6.0, 0.6), 0.6), g.mul(fields, 0.5))
    g.put(patch, ramp.inputs[0])
    g.L.new(ramp.outputs[0], bsdf.inputs["Base Color"])
    out = g.new("ShaderNodeOutputMaterial")
    g.L.new(bsdf.outputs[0], out.inputs["Surface"])
    me.materials.append(m)
    return ob


def make_atmosphere():
    """Physical aerial perspective: Rayleigh air (blue, 8 km scale height) + aerosol haze
    (1.2 km scale height). Distant clouds and hills fade into blue-grey exactly like photos."""
    me = bpy.data.meshes.new("Atmosphere")
    v = [(x, y, z) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    me.from_pydata(v, [], f)
    ob = bpy.data.objects.new("Atmosphere", me)
    ob.scale = (200000, 200000, 7000)
    ob.location = (0, 50000, 7000 - 1)
    ob.visible_shadow = False
    m, g = new_material("Atmosphere")
    pos = g.new("ShaderNodeNewGeometry").outputs["Position"]
    _, _, z = g.xyz(pos)
    ray_f = g.math("EXPONENT", g.mul(z, -1.0 / 8000.0))
    aer_f = g.math("EXPONENT", g.mul(z, -1.0 / 1200.0))
    ray = g.new("ShaderNodeVolumeCoefficients", phase="RAYLEIGH")
    g.put(g.vmath("MULTIPLY", (5.8e-6, 13.5e-6, 33.1e-6), ray_f), ray.inputs["Scatter Coefficients"])
    ray.inputs["Absorption Coefficients"].default_value = (0, 0, 0)
    aer = g.new("ShaderNodeVolumeScatter", phase="HENYEY_GREENSTEIN")
    aer.inputs["Anisotropy"].default_value = 0.7
    aer.inputs["Color"].default_value = (1, 1, 1, 1)
    g.put(g.mul(aer_f, AEROSOL), aer.inputs["Density"])
    add = g.new("ShaderNodeAddShader")
    g.L.new(ray.outputs[0], add.inputs[0])
    g.L.new(aer.outputs[0], add.inputs[1])
    out = g.new("ShaderNodeOutputMaterial")
    g.L.new(add.outputs[0], out.inputs["Volume"])
    me.materials.append(m)
    return ob


AEROSOL = 5e-6     # sea-level aerosol haze extinction /m (clear day; the sky texture already holds the rest)


def add_box(scene, name, loc, half, mat, rot_z=0.0):
    me = bpy.data.meshes.new(name)
    v = [(x, y, z) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    me.from_pydata(v, [], f)
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    ob.location, ob.scale = loc, half
    ob.rotation_euler.z = rot_z
    scene.collection.objects.link(ob)
    return ob


def add_cumulus(scene, name, mat, x, y, base, size, tall, rnd, turrets=None):
    """A cumulus is a cluster of rising thermals sharing one flat condensation base;
    the turrets are generated inside the material, so one box per cloud."""
    sz = size * tall
    add_box(scene, name, (x, y, base + 0.56 * sz),
            (size * rnd.uniform(1.0, 1.25), size * rnd.uniform(1.0, 1.25), sz), mat, rnd.uniform(0, 6.28))


def add_camera(scene, loc, target, lens=24):
    cd = bpy.data.cameras.new(scene.name + "_Cam")
    cd.lens = lens
    cd.clip_end = 600000
    cam = bpy.data.objects.new(scene.name + "_Cam", cd)
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(cam)
    scene.camera = cam


def scatter_heaps(scene, mat, n, base, size_rng, tall_rng, y_rng, seed, wedge=0.75, keep=()):
    rnd = random.Random(seed)
    placed = list(keep)
    tries = 0
    while n > 0 and tries < 5000:
        tries += 1
        y = y_rng[0] + (y_rng[1] - y_rng[0]) * rnd.random() ** 2
        x = rnd.uniform(-2500 - y * wedge, 2500 + y * wedge)
        size = rnd.uniform(*size_rng) * (1 + y / 60000)
        if any(math.hypot(x - px, y - py) < (size + ps) * 1.3 for px, py, ps in placed):
            continue
        # far clouds get fewer turrets: they are a few pixels wide anyway
        add_cumulus(scene, f"{scene.name}_{n:02d}", mat, x, y, base, size, rnd.uniform(*tall_rng), rnd,
                    turrets=None if y < 20000 else 1)
        placed.append((x, y, size))
        n -= 1


# =========================================================== the cloud catalogue
WATER = 0.045 * DENSITY_SCALE   # cumulus core extinction per metre
CUMULUS_PROFILE = [(0.0, 0.7), (0.25, 0.76), (0.65, 0.52), (1.0, 0.1)]
TOWER_PROFILE = [(0, 0.62), (0.2, 0.7), (0.5, 0.55), (0.8, 0.42), (1, 0.12)]


def build_cumulus_humilis():
    """Fair-weather cumulus: small, flat-based, wider than tall, 1-2 km base."""
    sc = setup_scene("Cumulus_humilis", 40, 228)
    mat = heap_material("Cumulus_humilis", WATER, [(0, 0.75), (0.3, 0.72), (0.7, 0.45), (1, 0.08)],
                        billow_scale=2.6)
    scatter_heaps(sc, mat, 45, 1200, (450, 1000), (0.3, 0.45), (1500, 40000), 11)
    add_camera(sc, (0, -3000, 60), (0, 9000, 2600))
    return sc


def build_cumulus_mediocris():
    """Moderate cumulus field with a few growing towers."""
    sc = setup_scene("Cumulus_mediocris", 32, 228)
    mat = heap_material("Cumulus_mediocris", WATER, CUMULUS_PROFILE)
    rnd = random.Random(3)
    add_cumulus(sc, "Med_hero", mat, -2600, 9000, 1400, 1700, 1.4, rnd, turrets=5)
    add_cumulus(sc, "Med_b", mat, 3600, 12000, 1400, 1500, 0.9, rnd, turrets=4)
    scatter_heaps(sc, mat, 30, 1400, (500, 1300), (0.45, 0.7), (3000, 60000), 7,
                  keep=[(-2600, 9000, 2200), (3600, 12000, 1900)])
    add_camera(sc, (0, -3000, 120), (0, 9000, 4300))
    return sc


def build_cumulus_congestus():
    """Towering cumulus: tall cauliflower tower, 4-7 km tops, sharp sunlit billows."""
    sc = setup_scene("Cumulus_congestus", 28, 235)
    mat = heap_material("Cumulus_congestus", WATER * 1.2, TOWER_PROFILE, warp=0.55, edge=0.05,
                        billow_scale=2.2)
    rnd = random.Random(5)
    add_cumulus(sc, "Congestus", mat, 0, 9000, 1300, 2400, 1.35, rnd, turrets=6)
    add_cumulus(sc, "Congestus_b", mat, -7500, 13000, 1300, 1800, 1.0, rnd, turrets=4)
    add_cumulus(sc, "Congestus_c", mat, 8000, 15000, 1300, 1600, 0.8, rnd, turrets=3)
    add_camera(sc, (0, -6000, 80), (0, 9000, 3600), 24)
    return sc


def build_cumulonimbus():
    """Thunderstorm: 10+ km tower capped by a flat ice anvil at the tropopause."""
    sc = setup_scene("Cumulonimbus", 22, 240)
    anvil = heap_material("Cumulonimbus", WATER * 1.3,
                          [(0, 0.46), (0.3, 0.45), (0.55, 0.42), (0.68, 0.46), (0.78, 0.58), (0.88, 0.63),
                           (0.95, 0.56), (1, 0.3)],
                          warp=0.3, top=(0.95, 0.86), anvil=True, edge=0.05, billow_scale=2.6, turrets=0,
                          shear=0.35)
    tower = heap_material("Cumulonimbus_tower", WATER * 1.3, TOWER_PROFILE, warp=0.5, edge=0.05,
                          billow_scale=2.2)
    add_box(sc, "Cumulonimbus", (-3000, 45000, 1200 + 0.56 * 7500), (16000, 10000, 7500), anvil)
    # feeder cells marching in on the flank, outside the main volume (overlaps are slow)
    rnd = random.Random(9)
    for t in range(3):
        add_cumulus(sc, f"Cb_feeder{t}", tower, -8000 - t * 3600, 31000 - t * 1500, 1200,
                    1500 - t * 250, 1.2 - t * 0.2, rnd)
    add_camera(sc, (0, -5000, 80), (0, 45000, 6000), 30)
    return sc


def build_stratocumulus():
    """Low lumpy deck in rolls with blue gaps, 0.5-2 km."""
    half = (90000, 90000, 300)
    sc = setup_scene("Stratocumulus", 30, 228)
    mat = layer_material("Stratocumulus", half, WATER * 0.7, "cells", cell=0.8, stretch=(0.6, 1.0),
                         coverage=0.8, soft=0.14, fade=(0.3, 0.6))
    add_box(sc, "Stratocumulus", (0, 0, 1100 + half[2]), half, mat, 0.4)
    add_camera(sc, (0, 0, 60), (0, 10000, 4000), 20)
    return sc


def build_stratus():
    """Featureless low grey sheet, often < 500 m: diffuse light, no shadows."""
    half = (120000, 120000, 250)
    sc = setup_scene("Stratus", 35, 228)
    mat = layer_material("Stratus", half, WATER * 0.35, "uniform", cell=0.25, coverage=0.92,
                         soft=0.25, fade=(0.5, 0.4), rough_base=0.6, regional=(0.2, 0.5))
    add_box(sc, "Stratus", (0, 0, 450 + half[2]), half, mat)
    add_camera(sc, (0, 0, 30), (0, 10000, 1800), 22)
    return sc


def build_altocumulus():
    """Mid-level sheet of small rounded cells (mackerel sky), 2-6 km."""
    half = (90000, 90000, 160)
    sc = setup_scene("Altocumulus", 30, 228)
    mat = layer_material("Altocumulus", half, WATER * 0.6, "mackerel", cell=1.6, coverage=0.62,
                         soft=0.16, fade=(0.45, 0.6), rough_base=0.4)
    add_box(sc, "Altocumulus", (0, 0, 4200 + half[2]), half, mat, 0.7)
    add_camera(sc, (0, 0, 40), (0, 10000, 7000), 20)
    return sc


def build_altostratus():
    """Grey-blue mid-level veil; the sun shows as if through ground glass."""
    half = (120000, 120000, 600)
    sc = setup_scene("Altostratus", 38, 175, sun_power=10.0)
    mat = layer_material("Altostratus", half, 0.0035, "uniform", cell=0.2, coverage=0.95,
                         soft=0.35, fade=(0.5, 0.5), rough_base=0.2, regional=(0.25, 0.6))
    add_box(sc, "Altostratus", (0, 0, 4500 + half[2]), half, mat)
    add_camera(sc, (0, 0, 40), (0, 10000, 5000), 20)
    return sc


def build_nimbostratus():
    """Thick, dark rain layer several km deep with ragged low base."""
    half = (120000, 120000, 1600)
    sc = setup_scene("Nimbostratus", 40, 228, sun_power=10.0)
    mat = layer_material("Nimbostratus", half, 0.0035, "uniform", cell=0.35, coverage=0.97,
                         soft=0.2, fade=(0.25, 0.3), rough_base=0.25, regional=(0.1, 0.4))
    add_box(sc, "Nimbostratus", (0, 0, 700 + half[2]), half, mat)
    add_camera(sc, (0, 0, 30), (0, 10000, 1500), 22)
    return sc


def build_cirrus():
    """High ice-crystal fibres and hooks (mares' tails), 6-12 km."""
    half = (150000, 150000, 700)
    sc = setup_scene("Cirrus", 35, 228)
    mat = layer_material("Cirrus", half, 0.004, "streaks", phase="ice", cell=0.3, coverage=0.9,
                         soft=0.3, fade=(0.6, 0.6), rough_base=0.6, regional=(0.35, 0.7))
    add_box(sc, "Cirrus", (0, 0, 9000 + half[2]), half, mat, 0.6)
    add_camera(sc, (0, 0, 40), (0, 10000, 9000), 20)
    return sc


def build_cirrocumulus():
    """Tiny high ripples / grains of ice cloud, 5-12 km."""
    half = (120000, 120000, 120)
    sc = setup_scene("Cirrocumulus", 35, 228)
    mat = layer_material("Cirrocumulus", half, 0.02, "cells", phase="ice", cell=6.0, stretch=(0.5, 1.0),
                         coverage=0.6, soft=0.12, fade=(0.5, 0.5), rough_base=0.2, regional=(0.4, 0.7))
    add_box(sc, "Cirrocumulus", (0, 0, 8000 + half[2]), half, mat, 0.3)
    add_camera(sc, (0, 0, 40), (0, 10000, 11000), 20)
    return sc


def build_cirrostratus():
    """Thin milky high veil that whitens the blue sky, sun still sharp."""
    half = (150000, 150000, 800)
    sc = setup_scene("Cirrostratus", 40, 175)
    mat = layer_material("Cirrostratus", half, 0.0009, "uniform", phase="ice", cell=0.15, coverage=0.9,
                         soft=0.4, fade=(0.6, 0.6), rough_base=0.3, regional=(0.3, 0.7))
    add_box(sc, "Cirrostratus", (0, 0, 8500 + half[2]), half, mat)
    add_camera(sc, (0, 0, 40), (0, 10000, 6000), 20)
    return sc


CATALOGUE = [
    ("cumulus_humilis", build_cumulus_humilis),
    ("cumulus_mediocris", build_cumulus_mediocris),
    ("cumulus_congestus", build_cumulus_congestus),
    ("cumulonimbus", build_cumulonimbus),
    ("stratocumulus", build_stratocumulus),
    ("stratus", build_stratus),
    ("nimbostratus", build_nimbostratus),
    ("altocumulus", build_altocumulus),
    ("altostratus", build_altostratus),
    ("cirrus", build_cirrus),
    ("cirrocumulus", build_cirrocumulus),
    ("cirrostratus", build_cirrostratus),
]

# =========================================================== main
bpy.ops.wm.read_factory_settings(use_empty=True)
GROUND = make_terrain()
ATMOSPHERE = make_atmosphere()
empty_scene = bpy.data.scenes[0]
built = []
for key, fn in CATALOGUE:
    if ONLY and key not in ONLY:
        continue
    built.append((key, fn()))
if bpy.context.window:
    bpy.context.window.scene = built[0][1]
bpy.data.scenes.remove(empty_scene)

out_dir = os.path.join(HERE, "renders")
os.makedirs(out_dir, exist_ok=True)
if not ONLY:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "cloud_library.blend"))
    print("SAVED cloud_library.blend")

if RENDER:
    import time
    for key, sc in built:
        t = time.time()
        sc.render.filepath = os.path.join(out_dir, key + ".png")
        bpy.ops.render.render(write_still=True, scene=sc.name)
        print(f"RENDERED {key} {time.time() - t:.0f}s")
