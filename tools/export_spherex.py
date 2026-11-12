# Exports SPHEREx_Master.blend to a web-ready GLB: curves -> meshes, Map Range roughness baked into
# the textures (glTF has no node for it), textures capped at 2K (solar array 4K), WebP, Y-up.
# Usage: blender -b SPHEREx_Master.blend --python tools/export_spherex.py -- models/spherex.glb
import bpy, numpy as np, sys
out = sys.argv[sys.argv.index('--')+1]
# 1. curves -> meshes
bpy.ops.object.select_all(action='DESELECT')
curves=[o for o in bpy.data.objects if o.type=='CURVE']
for o in curves: o.select_set(True)
bpy.context.view_layer.objects.active=curves[0]
bpy.ops.object.convert(target='MESH')
# 2. bake MAP_RANGE -> roughness into remapped image copies
for m in bpy.data.materials:
    nt=m.node_tree
    for mr in [n for n in nt.nodes if n.type=='MAP_RANGE']:
        src=mr.inputs['Value'].links[0].from_node; dst=mr.outputs['Result'].links[0].to_socket
        fmin,fmax,tmin,tmax=[mr.inputs[k].default_value for k in ('From Min','From Max','To Min','To Max')]
        print("MAPRANGE",m.name,fmin,fmax,tmin,tmax)
        img=src.image; key=f"{img.name}_{m.name}"
        new=img.copy(); new.name=key
        px=np.array(img.pixels[:],dtype=np.float32).reshape(-1,4)
        v=np.clip((px[:,:3]-fmin)/(fmax-fmin),0,1)*(tmax-tmin)+tmin
        px[:,:3]=v; new.pixels.foreach_set(px.ravel()); new.update()
        node=nt.nodes.new('ShaderNodeTexImage'); node.image=new; node.image.colorspace_settings.name='Non-Color'
        nt.links.new(src.inputs['Vector'].links[0].from_socket, node.inputs['Vector'])
        nt.links.new(node.outputs['Color'], dst)
        nt.nodes.remove(mr); nt.nodes.remove(src)
# 3. downscale textures for the web
for img in bpy.data.images:
    if img.size[0]==0: continue
    w,h=img.size; cap=4096 if img.name.startswith('solar') else 2048
    if max(w,h)>cap:
        s=cap/max(w,h); img.scale(int(w*s),int(h*s)); print("SCALED",img.name,img.size[:])
# 4. export meshes only
bpy.ops.object.select_all(action='DESELECT')
for o in bpy.data.objects:
    if o.type=='MESH': o.select_set(True)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_apply=True,
    export_cameras=False, export_lights=False, export_yup=True, export_image_format='WEBP',
    export_image_quality=88, export_texcoords=True, export_normals=True, export_tangents=False)
print("EXPORTED", out)
