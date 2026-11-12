# Bevel selected mesh edges

Open **Modeling → Mesh Tools**, select a mesh, switch to **Edge** mode, and select one or more edges in the viewport or component list. Choose **Bevel** under **Edit Topology**. The viewport shows the cut and highlights its replacement rails while you edit.

- **Width (fraction)** controls the face offset as a fraction of 45% of the shortest edge in the affected shells. Zero shows the source mesh. Some shapes need a smaller width to keep their original faces and rails.
- **Segments** ranges from 1 to 8. One produces a flat chamfer. Higher values produce a faceted rounded profile.
- Type a value, use the number field's step controls, or middle-drag a value or its label. Right-click a field for **Lock** and **Unlock**. Escape during a middle-drag restores the value from the start of the drag.
- **Apply Bevel** or Enter in a bevel field commits the displayed result in one undo step. **Cancel Bevel** or Escape restores the source and its edge selection. The selected rails after Apply are temporary. The resulting mesh saves and reopens in the existing MSB format.

Bevel supports closed convex shells with planar convex polygon faces and a distinct angle across each selected edge. Each selection must be the single shared edge between its two faces. Coplanar diagonals on triangulated primitives have no angle to bevel. A narrow profile that collapses at viewport precision requires a different width or selection. You can select adjacent edges, separate edges, or edges on multiple supported shells. It accepts up to 24 selected edges and 4,096 source vertices or face corners, with at most 8,192 result face corners. Invalid topology, boundaries in the affected shell, skinned meshes, blend shapes, imported normals and UVs are rejected. Original face IDs and assignments are retained. New profile faces inherit the material of the first neighboring face in the authored face order. Normals use the mesh's current flat or smooth shading.

This workflow follows the Maya 2026 **Edit Mesh → Bevel** command and its fractional width and segment controls. Musubi uses its existing docked **Mesh Tools** and commits editable polygon topology with an explicit Apply. [Maya Bevel workflow](https://help.autodesk.com/cloudhelp/ENU/MayaCRE-Modeling/files/GUID-80605B6D-79ED-4435-99FB-928508248469.htm) [Maya 2026 Bevel Options](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Modeling/files/GUID-A1C5EC72-AD48-4A7D-8577-1823B3832E14.htm)

## Example

Open `examples/modeling/mesh-bevel.msb` to compare the source cube, a single-edge chamfer, and a three-edge four-segment corner. On **Source cube**, choose the three edges sharing Vertex 7 to reproduce the rounded corner with Width `0.65` and Segments `4`. Regenerate the archive with `node scripts/create-mesh-bevel-example.mjs`.

The implementation uses original convex half-space clipping and shared edge intersections with Three.js 0.180.0's MIT-licensed vector and mesh APIs. The example is original geometry with no external assets. Spark 2.4.0 is unchanged.
