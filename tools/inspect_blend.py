import bpy, json, sys

def vec(v):
    try:
        return [round(float(x), 5) for x in v]
    except TypeError:
        return float(v)

out = {}
sc = bpy.context.scene
out["engine"] = sc.render.engine
out["resolution"] = [sc.render.resolution_x, sc.render.resolution_y]
out["frame"] = [sc.frame_start, sc.frame_end, sc.frame_current]
out["view_transform"] = sc.view_settings.view_transform
out["look"] = sc.view_settings.look
out["exposure"] = sc.view_settings.exposure
out["gamma"] = sc.view_settings.gamma

# Eevee bloom / settings
ee = getattr(sc, "eevee", None)
if ee:
    out["eevee"] = {}
    for k in ("use_bloom","bloom_threshold","bloom_intensity","bloom_radius","bloom_color","use_gtao","use_ssr","taa_render_samples"):
        if hasattr(ee, k):
            v = getattr(ee, k)
            out["eevee"][k] = vec(v) if hasattr(v, "__iter__") else (float(v) if isinstance(v,(int,float)) else str(v))
if sc.render.engine == 'CYCLES':
    cy = sc.cycles
    out["cycles"] = {"samples": cy.samples, "preview_samples": cy.preview_samples}

# World
w = sc.world
if w:
    wd = {"name": w.name, "use_nodes": w.use_nodes}
    if w.use_nodes:
        wd["nodes"] = []
        for n in w.node_tree.nodes:
            nd = {"type": n.bl_idname, "name": n.name}
            for inp in n.inputs:
                if inp.is_linked: continue
                if hasattr(inp, "default_value"):
                    try: nd.setdefault("inputs", {})[inp.name] = vec(inp.default_value)
                    except Exception: pass
            wd["nodes"].append(nd)
    out["world"] = wd

def dump_nodetree(nt):
    nodes = []
    for n in nt.nodes:
        nd = {"type": n.bl_idname, "name": n.name}
        if n.bl_idname == "ShaderNodeTexImage" and n.image:
            nd["image"] = {"name": n.image.name, "filepath": n.image.filepath, "size": list(n.image.size), "packed": n.image.packed_file is not None, "colorspace": n.image.colorspace_settings.name}
        if hasattr(n, "inputs"):
            ins = {}
            for inp in n.inputs:
                tag = inp.name
                if inp.is_linked:
                    frm = inp.links[0].from_node
                    ins[tag] = {"linked_from": f"{frm.name}({frm.bl_idname}).{inp.links[0].from_socket.name}"}
                elif hasattr(inp, "default_value"):
                    try: ins[tag] = vec(inp.default_value)
                    except Exception: pass
            nd["inputs"] = ins
        nodes.append(nd)
    links = [f"{l.from_node.name}.{l.from_socket.name} -> {l.to_node.name}.{l.to_socket.name}" for l in nt.links]
    return {"nodes": nodes, "links": links}

# Materials
out["materials"] = {}
for m in bpy.data.materials:
    md = {"use_nodes": m.use_nodes, "blend_method": m.blend_method, "users": m.users}
    if m.use_nodes:
        md["tree"] = dump_nodetree(m.node_tree)
    out["materials"][m.name] = md

# Objects
out["objects"] = []
deps = bpy.context.evaluated_depsgraph_get()
for o in sc.objects:
    od = {"name": o.name, "type": o.type, "visible": o.visible_get(),
          "hide_render": o.hide_render,
          "loc": vec(o.location), "rot_euler": vec(o.rotation_euler), "scale": vec(o.scale),
          "parent": o.parent.name if o.parent else None}
    if o.type == 'MESH':
        od["verts"] = len(o.data.vertices)
        od["polys"] = len(o.data.polygons)
        ev = o.evaluated_get(deps)
        try:
            od["polys_evaluated"] = len(ev.to_mesh().polygons)
            ev.to_mesh_clear()
        except Exception:
            pass
        od["materials"] = [ms.material.name if ms.material else None for ms in o.material_slots]
        od["modifiers"] = [{"type": mod.type, "name": mod.name, **({"levels": mod.levels, "render_levels": mod.render_levels} if mod.type=='SUBSURF' else {})} for mod in o.modifiers]
        od["particle_systems"] = [{"name": ps.name, "count": ps.settings.count, "type": ps.settings.type, "render_type": ps.settings.render_type, "instance_object": ps.settings.instance_object.name if ps.settings.instance_object else None} for ps in o.particle_systems]
        od["shape_keys"] = bool(o.data.shape_keys)
    if o.type == 'LIGHT':
        L = o.data
        od["light"] = {"type": L.type, "color": vec(L.color), "energy": float(L.energy),
                        "shadow_soft_size": getattr(L, "shadow_soft_size", None)}
        if L.type == 'AREA': od["light"]["size"] = [L.size, getattr(L, "size_y", L.size)]
        if L.type == 'SPOT': od["light"]["spot"] = [L.spot_size, L.spot_blend]
        if L.use_nodes:
            od["light"]["tree"] = dump_nodetree(L.node_tree)
    if o.type == 'CAMERA':
        c = o.data
        od["camera"] = {"lens_mm": c.lens, "sensor": c.sensor_width, "clip": [c.clip_start, c.clip_end],
                        "dof": c.dof.use_dof, "fstop": c.dof.aperture_fstop,
                        "focus_object": c.dof.focus_object.name if c.dof.focus_object else None,
                        "focus_distance": c.dof.focus_distance,
                        "matrix_world": [vec(r) for r in o.matrix_world]}
    if o.animation_data and o.animation_data.action:
        od["animated"] = o.animation_data.action.name
    out["objects"].append(od)

out["collections"] = [{ "name": c.name, "objects": [o.name for o in c.objects], "hidden": c.hide_render } for c in bpy.data.collections]

print("JSONSTART")
print(json.dumps(out, indent=1))
print("JSONEND")
