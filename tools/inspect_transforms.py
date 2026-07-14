import bpy, json, mathutils

def vec(v):
    return [round(float(x), 6) for x in v]

out = {"objects": {}}
sc = bpy.context.scene
deps = bpy.context.evaluated_depsgraph_get()

for o in sc.objects:
    od = {"type": o.type, "matrix_world": [vec(r) for r in o.matrix_world],
          "loc": vec(o.matrix_world.translation)}
    if o.type == 'MESH':
        # world-space bounding box
        bb = [o.matrix_world @ mathutils.Vector(c) for c in o.bound_box]
        xs=[p.x for p in bb]; ys=[p.y for p in bb]; zs=[p.z for p in bb]
        od["bbox_world"] = [[round(min(xs),4),round(min(ys),4),round(min(zs),4)],[round(max(xs),4),round(max(ys),4),round(max(zs),4)]]
        od["dims"] = vec(o.dimensions)
        for mod in o.modifiers:
            if mod.type == 'ARRAY':
                od.setdefault("arrays", []).append({
                    "count": mod.count, "fit_type": mod.fit_type,
                    "use_object_offset": mod.use_object_offset,
                    "offset_object": mod.offset_object.name if mod.offset_object else None,
                    "use_relative_offset": mod.use_relative_offset,
                    "relative_offset": vec(mod.relative_offset_displace),
                })
    if o.type == 'CURVES':
        cv = o.data
        ev = o.evaluated_get(deps)
        evd = ev.data
        od["curves"] = {"num_curves": len(cv.curves), "num_points": len(cv.points),
                        "num_curves_eval": len(evd.curves) if hasattr(evd, 'curves') else None,
                        "num_points_eval": len(evd.points) if hasattr(evd, 'points') else None,
                        "materials": [ms.material.name if ms.material else None for ms in o.material_slots],
                        "attributes": list(cv.attributes.keys()),
                        "surface": cv.surface.name if cv.surface else None}
        try:
            rad = cv.attributes.get("radius")
            if rad:
                vals = [p.value for p in rad.data[:20]]
                od["curves"]["radius_sample"] = [round(v,5) for v in vals]
        except Exception as e:
            od["curves"]["radius_err"] = str(e)
        # sample first curve points
        try:
            pos = cv.attributes["position"].data
            first = [vec(pos[i].vector) for i in range(min(6, len(cv.points)))]
            od["curves"]["first_points_local"] = first
        except Exception as e:
            od["curves"]["pos_err"] = str(e)
    if o.type == 'CURVE':
        od["curve"] = {"splines": len(o.data.splines), "bevel_depth": o.data.bevel_depth,
                       "materials": [ms.material.name if ms.material else None for ms in o.material_slots]}
    if o.type == 'LIGHT':
        od["light"] = {"type": o.data.type, "energy": o.data.energy, "color": vec(o.data.color),
                       "radius": getattr(o.data, "shadow_soft_size", None),
                       "use_custom_distance": o.data.use_custom_distance,
                       "spot": [o.data.spot_size, o.data.spot_blend] if o.data.type=='SPOT' else None,
                       "area": ([o.data.size, getattr(o.data,'size_y',o.data.size)], o.data.shape) if o.data.type=='AREA' else None}
    if o.type == 'CAMERA':
        od["camera"] = {"lens": o.data.lens, "sensor_width": o.data.sensor_width,
                        "sensor_fit": o.data.sensor_fit, "shift": [o.data.shift_x, o.data.shift_y],
                        "clip": [o.data.clip_start, o.data.clip_end]}
    out["objects"][o.name] = od

print("JSONSTART")
print(json.dumps(out, indent=1))
print("JSONEND")
