"""Export Flower_v9.blend -> flower.glb for three.js.
- Converts hair Curves objects into ribbon/tube meshes (glTF has no hair).
- Deletes hidden/helper objects and lights/camera (rebuilt manually in JS).
- Applies array modifiers via export_apply.
Run: blender -b Flower_v9.blend --python export_glb.py -- /out/flower.glb
"""
import bpy, bmesh, sys, math
from mathutils import Vector

out_path = sys.argv[sys.argv.index("--") + 1]

sc = bpy.context.scene
deps = bpy.context.evaluated_depsgraph_get()

# ---------- hair curves -> ribbon meshes ----------
# name: (root_width, tip_width, style)
HAIR_SPECS = {
    "Curves":     dict(root=0.004, tip=0.001, mat="StamenHair", newname="fuzz_center"),
    "Curves.002": dict(root=0.028, tip=0.010, mat="Material.005", newname="filaments"),
    "Curves.004": dict(root=0.005, tip=0.0015, mat="StamenHair", newname="fuzz_stem"),
}

def curves_to_ribbons(ob, spec):
    ev = ob.evaluated_get(deps)
    cv = ev.data
    n_curves = len(cv.curves)
    pos = cv.attributes["position"].data
    mw = ob.matrix_world

    bm = bmesh.new()
    up = Vector((0, 0, 1))  # camera looks down -Y in blender? no: down -Z; ribbons face +Z
    for ci in range(n_curves):
        c = cv.curves[ci]
        first = c.first_point_index
        npts = c.points_length
        pts = [mw @ Vector(pos[first + i].vector) for i in range(npts)]
        if npts < 2:
            continue
        # per-point side vectors: perpendicular to tangent, facing viewer (+Z blender)
        rows = []
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, npts - 1)] - pts[max(i - 1, 0)])
            if t.length < 1e-9:
                t = Vector((0, 0, 1))
            t.normalize()
            side = t.cross(up)
            if side.length < 1e-6:
                side = Vector((1, 0, 0))
            side.normalize()
            w = spec["root"] + (spec["tip"] - spec["root"]) * (i / (npts - 1))
            w *= 0.5
            rows.append((bm.verts.new(p - side * w), bm.verts.new(p + side * w)))
        for i in range(len(rows) - 1):
            a0, a1 = rows[i]
            b0, b1 = rows[i + 1]
            bm.faces.new((a0, a1, b1, b0))
    me = bpy.data.meshes.new(spec["newname"])
    bm.to_mesh(me)
    bm.free()
    new = bpy.data.objects.new(spec["newname"], me)
    mat = bpy.data.materials.get(spec["mat"])
    if mat:
        me.materials.append(mat)
    sc.collection.objects.link(new)
    return new

made = []
for name, spec in HAIR_SPECS.items():
    ob = sc.objects.get(name)
    if ob:
        made.append(curves_to_ribbons(ob, spec))
        print("RIBBONS", spec["newname"], "polys:", len(made[-1].data.polygons))

# ---------- rename for clean JS handles ----------
RENAME = {
    "Petal 1": "petal_1", "Petal 2": "petal_2", "Petal 3": "petal_3",
    "Petal 4": "petal_4", "Petal 5": "petal_5",
    "Stamen": "center_disc", "Stem": "stem", "Plane": "backdrop",
    "stamen1": "stamen_a", "stamen2": "stamen_b",
    "stamen3": "stamen_c", "stamen3.001": "stamen_d",
}
for old, new in RENAME.items():
    ob = sc.objects.get(old)
    if ob:
        ob.name = new
        if ob.data: ob.data.name = new

# ---------- apply ARRAY modifiers BEFORE deleting their offset Empties ----------
for ob in list(sc.objects):
    if ob.type != 'MESH' or not ob.modifiers:
        continue
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    for mod in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    ob.select_set(False)
    print("APPLIED", ob.name, "polys:", len(ob.data.polygons))

# ---------- delete everything we don't ship ----------
DELETE = ["ProtoPetal", "HairCenter", "Roundcube", "Circle",
          "Curves", "Curves.002", "Curves.004",
          "Empty", "Empty.001", "Empty.002"]
for o in list(sc.objects):
    if o.type in ("LIGHT", "CAMERA") or o.name in DELETE:
        bpy.data.objects.remove(o, do_unlink=True)

print("EXPORTING:", [o.name for o in sc.objects])

bpy.ops.export_scene.gltf(
    filepath=out_path,
    export_format="GLB",
    export_apply=True,          # applies array modifiers
    export_yup=True,
    export_texcoords=False,     # no textures anywhere
    export_normals=True,
    export_materials="EXPORT",
    export_cameras=False,
    export_lights=False,
    export_animations=False,
    export_skins=False,
    export_morph=False,
)
print("DONE", out_path)
