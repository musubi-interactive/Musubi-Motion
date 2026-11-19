# Mesh Export

Open **Tools → Mesh Export** at [/tools/mesh-export/](/tools/mesh-export/). Choose a local Musubi Motion project (.msb), then select the polygon meshes to include. The initial selection includes all exportable meshes. **Clear** and **Select all** apply to the export list. Each row represents one mesh shape, so multiple shapes under the same transform can be selected independently. A project can contain a mix of exportable and unavailable meshes.

- **World at frame** uses the saved playhead by default. Enter a different frame within the saved timeline to bake that pose, including parent transforms, pivots, animation, driven keys and constraints. Fractional frames are supported.
- **Source mesh-local** writes each mesh in its original geometry coordinates. Multiple objects may overlap in this mode.
- **Keep polygons** preserves face boundaries, including n-gons. Choose **Use editor triangles** to retain the editor's tessellation, especially when importing concave or nonplanar polygons into a program that triangulates differently.

The tool writes one OBJ named after the source file. Each object name starts with its position in the mesh list, followed by its sanitized name. Primary UVs and stored normals travel with the corresponding vertices, preserving split vertices at UV seams. World-space normals use the inverse transpose of the world basis. Materials, textures, additional UV sets, smoothing settings, visibility, hierarchy and animation data are omitted. The source MSB stays intact, and other scene object types are excluded. To export a skinned or blend-shape mesh, first prepare a static copy with the deformation baked into its geometry.

The layout follows Maya's separation of selection and format-specific options. Musubi uses a standalone browser page, explicit shape selection, OBJ as the fixed format and a native file download. Tab, Space and Enter work with native controls. Mesh Export does not introduce editor shortcuts, gizmos or text-field scrubbing. [Autodesk Maya 2026 Export All/Selection Options](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-ManagingScenes/files/GUID-A1E550E4-1510-4D45-A811-5E424A8D3924.htm)

The exporter is original Musubi Motion code and uses the existing archive validator, animation and rig evaluators, editor triangulation and Three.js 0.180.0 (MIT). OBJLoader verifies the procedural regression fixture. The current archive validator rejects mirrored transform matrices. The reflected winding safeguard is exercised directly at the serializer boundary.
