"""Procedural volumetric cumulus field for Blender 5.x (Cycles).

Run:  blender -b -P make_clouds.py -- [--preview] [--render]
Saves clouds.blend next to this script; --render also writes a PNG.
"""
import bpy, math, random, sys, os
from mathutils import Vector, Euler

HERE = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
PREVIEW = "--preview" in argv
RENDER = "--render" in argv

SUN_ELEV = 32.0      # degrees
SUN_AZ = 228.0       # sky-texture sun rotation (0 = sun toward +Y, +90 = toward -X)
CLOUD_BASE = 1400.0  # metres, flat condensation level
DENSITY = 0.06      # extinction per metre at the cloud core
SEED = 7

# ---------------------------------------------------------------- reset
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
random.seed(SEED)

# ---------------------------------------------------------------- render
scene.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
try:
    prefs.compute_device_type = "OPTIX"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == "OPTIX"
    scene.cycles.device = "GPU"
except Exception:
    scene.cycles.device = "CPU"

cy = scene.cycles
FAST = "--fast" in argv          # quick 1080p: fewer samples, denoiser cleans up
cy.samples = 48 if PREVIEW else (16 if FAST else 256)
cy.use_denoising = True
cy.max_bounces = 64
cy.volume_bounces = 32          # multiple scattering is what makes clouds look white and soft
cy.diffuse_bounces = 4
cy.glossy_bounces = 4
cy.transparent_max_bounces = 16
cy.volume_step_rate = 1.0
cy.volume_max_steps = 1024
cy.caustics_reflective = cy.caustics_refractive = False
cy.sample_clamp_indirect = 20.0
if FAST:
    cy.volume_bounces = 12
    cy.max_bounces = 16
    cy.volume_step_rate = 2.0
    cy.denoiser = "OPTIX"
    DENSITY *= 0.45   # thinner clouds stay bright with fewer volume bounces
scene.render.resolution_x = 960 if PREVIEW else 1920
scene.render.resolution_y = 540 if PREVIEW else 1080
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"
scene.view_settings.exposure = 0.0
scene.render.film_transparent = False

# ---------------------------------------------------------------- sky + sun
world = bpy.data.worlds.new("Sky")
scene.world = world
world.use_nodes = True
wn = world.node_tree.nodes
wl = world.node_tree.links
wn.clear()
sky = wn.new("ShaderNodeTexSky")
sky.sky_type = "MULTIPLE_SCATTERING"
sky.sun_disc = False                    # the Sun lamp below provides the sun
sky.sun_elevation = math.radians(SUN_ELEV)
sky.sun_rotation = math.radians(SUN_AZ)
sky.altitude = 300.0
bg = wn.new("ShaderNodeBackground")
bg.inputs["Strength"].default_value = 0.22
out = wn.new("ShaderNodeOutputWorld")
wl.new(sky.outputs[0], bg.inputs[0])
wl.new(bg.outputs[0], out.inputs[0])

sun_data = bpy.data.lights.new("Sun", "SUN")
sun_data.energy = 10.0 if FAST else 7.0
sun_data.angle = math.radians(0.53)
sun_data.color = (1.0, 0.95, 0.88)
sun = bpy.data.objects.new("Sun", sun_data)
scene.collection.objects.link(sun)
el, az = math.radians(SUN_ELEV), math.radians(SUN_AZ)
SUN_DIR = Vector((-math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el)))  # matches Cycles sky
sun.rotation_euler = (-SUN_DIR).to_track_quat("-Z", "Y").to_euler()

# ---------------------------------------------------------------- ground
bpy.ops.mesh.primitive_plane_add(size=200000, location=(0, 0, 0))
ground = bpy.context.active_object
ground.name = "Ground"
gm = bpy.data.materials.new("Ground")
gm.use_nodes = True
gnt = gm.node_tree
bsdf = gnt.nodes["Principled BSDF"]
bsdf.inputs["Roughness"].default_value = 0.9
gtex = gnt.nodes.new("ShaderNodeTexNoise")
gtex.inputs["Scale"].default_value = 0.0004
gtex.inputs["Detail"].default_value = 10
gramp = gnt.nodes.new("ShaderNodeValToRGB")
gramp.color_ramp.elements[0].color = (0.035, 0.05, 0.022, 1)
gramp.color_ramp.elements[1].color = (0.09, 0.085, 0.05, 1)
gnt.links.new(gtex.outputs["Fac"], gramp.inputs[0])
bsdf.inputs["Specular IOR Level"].default_value = 0.15
# cheap aerial perspective: blend ground albedo toward a bright haze with distance
cdata = gnt.nodes.new("ShaderNodeCameraData")
haze = gnt.nodes.new("ShaderNodeMapRange")
haze.interpolation_type = "SMOOTHSTEP"
gnt.links.new(cdata.outputs["View Distance"], haze.inputs["Value"])
haze.inputs["From Min"].default_value = 2000
haze.inputs["From Max"].default_value = 60000
haze.inputs["To Max"].default_value = 0.85
hmix = gnt.nodes.new("ShaderNodeMix")
hmix.data_type = "RGBA"
gnt.links.new(haze.outputs["Result"], hmix.inputs["Factor"])
gnt.links.new(gramp.outputs[0], hmix.inputs["A"])
hmix.inputs["B"].default_value = (0.35, 0.42, 0.5, 1)
gnt.links.new(hmix.outputs["Result"], bsdf.inputs["Base Color"])
ground.data.materials.append(gm)

# ---------------------------------------------------------------- cloud material
def build_cloud_material():
    m = bpy.data.materials.new("Cumulus")
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    N.clear()

    def node(t, **inputs):
        n = N.new(t)
        for k, v in inputs.items():
            n.inputs[k].default_value = v
        return n

    def vmath(op, a, b=None, **kw):
        n = N.new("ShaderNodeVectorMath")
        n.operation = op
        L.new(a, n.inputs[0])
        if b is not None:
            if isinstance(b, (tuple, list)):
                n.inputs[1].default_value = b
            elif isinstance(b, (int, float)):
                n.inputs["Scale"].default_value = b
            else:
                L.new(b, n.inputs[1])
        return n.outputs["Value" if op in ("LENGTH", "DOT_PRODUCT", "DISTANCE") else "Vector"]

    def math_(op, a, b=None, clamp=False):
        n = N.new("ShaderNodeMath")
        n.operation = op
        n.use_clamp = clamp
        for i, x in enumerate((a, b)):
            if x is None:
                continue
            if isinstance(x, (int, float)):
                n.inputs[i].default_value = x
            else:
                L.new(x, n.inputs[i])
        return n.outputs[0]

    def maprange(x, a, b, c=0.0, d=1.0, interp="SMOOTHSTEP"):
        n = N.new("ShaderNodeMapRange")
        n.interpolation_type = interp
        n.clamp = True
        L.new(x, n.inputs["Value"])
        n.inputs["From Min"].default_value = a
        n.inputs["From Max"].default_value = b
        n.inputs["To Min"].default_value = c
        n.inputs["To Max"].default_value = d
        return n.outputs["Result"]

    tc = N.new("ShaderNodeTexCoord")
    oi = N.new("ShaderNodeObjectInfo")
    P = tc.outputs["Object"]                     # cube local space, roughly [-1, 1]

    # per-cloud seed offset so every cloud is unique
    seed = vmath("MULTIPLY", oi.outputs["Random"], (137.0, 71.0, 213.0))
    Ps = vmath("ADD", P, seed)

    # large-scale domain warp -> irregular silhouette
    warp = node("ShaderNodeTexNoise", Scale=1.1, Detail=3.0, Roughness=0.5)
    L.new(Ps, warp.inputs["Vector"])
    w = vmath("SUBTRACT", warp.outputs["Color"], (0.5, 0.5, 0.5))
    w = vmath("MULTIPLY", w, (0.75, 0.75, 0.45))
    Pw = vmath("ADD", P, w)

    # base envelope: dome that is wide at the base and rounded at the top
    sep = N.new("ShaderNodeSeparateXYZ")
    L.new(Pw, sep.inputs[0])
    h = maprange(sep.outputs["Z"], -0.55, 0.85, 0.0, 1.0, "LINEAR")      # 0 at base, 1 at top
    prof = N.new("ShaderNodeFloatCurve")                                  # horizontal radius vs height
    pts = prof.mapping.curves[0].points
    pts[0].location = (0.0, 0.7)
    pts[1].location = (1.0, 0.1)
    pts.new(0.25, 0.76)
    pts.new(0.65, 0.52)
    prof.mapping.update()
    L.new(h, prof.inputs["Value"])
    rad = prof.outputs[0]
    comb = N.new("ShaderNodeCombineXYZ")
    L.new(sep.outputs["X"], comb.inputs["X"])
    L.new(sep.outputs["Y"], comb.inputs["Y"])
    rxy = vmath("LENGTH", comb.outputs[0])
    base = math_("SUBTRACT", rad, rxy)
    # top rounding
    top = maprange(sep.outputs["Z"], 0.95, 0.55, 0.0, 1.0)
    base = math_("SUBTRACT", base, math_("MULTIPLY", math_("SUBTRACT", 1.0, top), 0.6))

    # cauliflower billows: inverted Worley (F1) at two scales, stronger near the top
    def billow(scale, amp):
        v = N.new("ShaderNodeTexVoronoi")
        v.feature = "F1"
        v.distance = "EUCLIDEAN"
        v.inputs["Scale"].default_value = scale
        v.inputs["Randomness"].default_value = 1.0
        L.new(Ps, v.inputs["Vector"])
        b = math_("SUBTRACT", 0.55, v.outputs["Distance"])
        return math_("MULTIPLY", b, amp)

    b1 = billow(2.6, 0.55)
    b2 = billow(6.0, 0.28)
    b3 = billow(13.0, 0.12)
    billows = math_("ADD", math_("ADD", b1, b2), b3)
    billow_amt = maprange(h, 0.0, 0.6, 0.45, 1.0)
    billows = math_("MULTIPLY", billows, billow_amt)

    # fine fbm erosion for wispy edges
    fine = node("ShaderNodeTexNoise", Scale=22.0, Detail=6.0, Roughness=0.6)
    L.new(Ps, fine.inputs["Vector"])
    fine_v = math_("MULTIPLY", math_("SUBTRACT", fine.outputs["Fac"], 0.5), 0.22)

    d = math_("ADD", math_("ADD", base, billows), fine_v)

    # flat condensation base (unwarped z) - cumulus have sharp flat bottoms
    sep0 = N.new("ShaderNodeSeparateXYZ")
    L.new(P, sep0.inputs[0])
    floor = maprange(sep0.outputs["Z"], -0.6, -0.53)
    d = math_("MULTIPLY", d, floor)

    dens = maprange(d, 0.0, 0.09, 0.0, 1.0, "SMOOTHERSTEP")
    # slightly thinner toward the bottom for a softer base
    dens = math_("MULTIPLY", dens, maprange(h, 0.0, 0.25, 0.6, 1.0))

    dens_val = N.new("ShaderNodeValue")
    dens_val.name = dens_val.label = "Cloud Density"
    dens_val.outputs[0].default_value = DENSITY
    dens = math_("MULTIPLY", dens, dens_val.outputs[0])

    # Mie phase function with ~20 µm droplets: real cloud forward scattering / silver lining
    vol = N.new("ShaderNodeVolumeScatter")
    vol.phase = "MIE"
    vol.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    vol.inputs["Diameter"].default_value = 20.0
    L.new(dens, vol.inputs["Density"])

    o = N.new("ShaderNodeOutputMaterial")
    L.new(vol.outputs[0], o.inputs["Volume"])
    return m


cloud_mat = build_cloud_material()

# ---------------------------------------------------------------- clouds
col = bpy.data.collections.new("Clouds")
scene.collection.children.link(col)

def add_cloud(i, x, y, size, tall=1.0):
    bpy.ops.mesh.primitive_cube_add(size=2.0)
    ob = bpy.context.active_object
    for c in ob.users_collection:
        c.objects.unlink(ob)
    col.objects.link(ob)
    ob.name = f"Cumulus_{i:02d}"
    sx = size * random.uniform(0.9, 1.25)
    sy = size * random.uniform(0.9, 1.25)
    sz = size * random.uniform(0.45, 0.7) * tall
    ob.scale = (sx, sy, sz)
    # the shader's flat base sits at local z = -0.56
    ob.location = (x, y, CLOUD_BASE + 0.56 * sz)
    ob.rotation_euler.z = random.uniform(0, math.tau)
    ob.data.materials.append(cloud_mat)
    ob.visible_shadow = True
    return ob

# hero cloud plus a scattered field receding to the horizon
add_cloud(0, -2600, 9000, 1700, tall=1.9)   # towering congestus
add_cloud(1, 3200, 12000, 1500, tall=1.3)
placed = [(-2600, 9000, 1700), (3200, 12000, 1500)]
i = 2
tries = 0
while i < 40 and tries < 4000:
    tries += 1
    x = random.uniform(-26000, 26000)
    y = random.uniform(3000, 60000)
    size = random.uniform(500, 1400) * (1.0 + y / 60000)
    if any(math.hypot(x - px, y - py) < (size + ps) * 1.15 for px, py, ps in placed):
        continue
    # keep the field inside the camera frustum-ish wedge
    if abs(x) > 2500 + y * 0.75:
        continue
    add_cloud(i, x, y, size)
    placed.append((x, y, size))
    i += 1

# ---------------------------------------------------------------- camera
cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 24
cam_data.clip_end = 300000
cam = bpy.data.objects.new("Camera", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam.location = (0, -3000, 120)
target = Vector((0, 9000, 4300))
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()

blend_path = os.path.join(HERE, "clouds.blend")
bpy.ops.wm.save_as_mainfile(filepath=blend_path)
print("SAVED", blend_path)

if RENDER:
    scene.render.filepath = os.path.join(HERE, "preview.png" if PREVIEW else "render.png")
    bpy.ops.render.render(write_still=True)
    print("RENDERED", scene.render.filepath)
