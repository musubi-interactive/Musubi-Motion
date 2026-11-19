# OBJ UV Layout

Open **UV Layout** from the `/tools/` launcher on a Musubi Motion server. Run `npm run dev`, or run `npm run build` followed by `npm run preview`.

1. Choose a local UTF-8 OBJ. The layout selects all polygon objects initially. Use the object checkboxes to isolate the mesh you plan to paint.
2. Choose **All polygon edges** for the original face outlines or **Island borders** to see seams and open boundaries. The checker is a preview aid.
3. Enter integer **Tile U** and **Tile V** and apply the tile, or jump to a tile containing the first edge in the current object and edge selection. Tile 0, 0 is UDIM 1001. Conventional UDIM labels appear for U 0–9 and V ≥ 0. Coordinates elsewhere remain available by their signed tile indices.
4. Choose a resolution and line color, then download the transparent PNG. Use it as a guide layer in a texture painting application.

The layout preserves original n-gons and independent position and UV indices. A UV island joins faces through a shared position edge with the same texture indices at both ends. Duplicated UV indices define seams even if their coordinates coincide. Missing-UV faces are counted and skipped. The diagnostics count complete faces with near-zero signed UV area and faces with any UV outside tile 0, 0. Tile clipping preserves edges that cross a tile without rewriting the source coordinates. Use UV Diagnostics for density and overlap checks.

The tool reads OBJ `o` names and polygon `f` records with absolute or relative indices. Files without named objects appear as one default object. Material, group, point, line and free-form surface records are outside the UV layout. Limits are 32 MiB, 200,000 positions, 200,000 UVs, 200,000 normals, 100,000 faces, 500,000 face corners and 1,000 objects containing faces. Replacing a file keeps the prior preview until the new OBJ has been parsed successfully.

The workflow follows Maya’s UV Snapshot selection, capture region, resolution and line-color controls. Musubi uses a browser-local tile preview and exports one square PNG at a time. [Autodesk Maya UV Snapshot](https://help.autodesk.com/cloudhelp/2027/ENU/Maya-Modeling/files/GUID-26F3DFAB-A6D9-4F9E-A11A-2BD9EF1C3DF1.htm)

## UV Diagnostics

1. Select your objects and set the square **Texture size** and **Unit scale**. Unit scale is the length of an OBJ coordinate unit in your chosen measurement units. For example, enter 0.01 if OBJ coordinates are centimetres and you want texels per metre.
2. Leave **Overlap tiles** blank to use the current tile, or enter up to eight signed U, V pairs such as `-1,-2; 0,-2`. Click **Analyze UVs**. Density covers the full selected objects and islands. Overlaps are measured inside the specified tiles.
3. Choose an object to see its density and excluded-face counts. Select an island, density outlier or overlap pair to highlight it in the preview. A pair is identified by its OBJ source lines and its tile.
4. **Download JSON report** saves the exact source file's SHA-256, selected objects and tiles, density settings and values, overlaps, excluded-face counts and analysis limits. The source face references include the zero-based object and mapped-face indices, OBJ line number and one-based island number.

Density in texels per measurement unit is the map size multiplied by the square root of total UV area divided by total source surface area, then divided by unit scale. The summary weights each face by its source surface area when aggregating squared density. A face more than 25% above or below its object density is an outlier. The report includes the count and up to the 50 most extreme per object.

Valid concave polygons use area-checked triangulation in UV space. Source and UV polygons must both be simple and have positive area. Faces with missing UVs, self-intersections, near-zero area, nonplanar source geometry or more than 64 corners are counted separately and excluded from density and overlap. The position vertices are the original OBJ X, Y and Z values. The planarity threshold is 10⁻⁷ times the face extent and the area threshold is 10⁻¹² times the squared polygon span. A reported overlap exceeds 10⁻¹⁰ square UV units inside one selected tile, so edge and vertex contact are ignored. Stacked and reversed faces can overlap. A pair spanning several selected tiles can appear once per tile.

The local analysis worker can be canceled. The overlap scan stops after finding an additional pair beyond the first 500, or at 2 million spatial candidate visits or 1 million triangle intersection tests. The status and report identify any truncated scan. Density summaries still cover all supported faces. Selecting a finding highlights the preview and the original snapshot export uses its own settings.

Musubi maps the Maya 2026 UV Toolkit's **Texel Density > Get** and **Map Size** to the workbench's object and island measurements. Maya's **Select > Overlapping** and **View > Shaded** map to face pair selection and highlighting in the tile preview. Numeric fields support native typing and middle-drag preview. Escape restores the previous value, and **Undo setting** reverses a completed edit. [Autodesk Maya UV Toolkit](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Modeling/files/GUID-73BF7546-3BF2-44F3-9192-15A024CEC173.htm) · [Select menu](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Modeling/files/GUID-DB08A540-8F7B-4B1E-8192-D346C176833C.htm) · [View menu](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Modeling/files/GUID-E9FE00F2-5B8B-4224-9E96-878E9FBAA466.htm)
