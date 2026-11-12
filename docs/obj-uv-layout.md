# OBJ UV Layout

Open **UV Layout** from the `/tools/` launcher on a Musubi Motion server. Run `npm run dev`, or run `npm run build` followed by `npm run preview`.

1. Choose a local UTF-8 OBJ. The layout selects all polygon objects initially. Use the object checkboxes to isolate the mesh you plan to paint.
2. Choose **All polygon edges** for the original face outlines or **Island borders** to see seams and open boundaries. The checker is a preview aid.
3. Enter integer **Tile U** and **Tile V** and apply the tile, or jump to a tile containing the first edge in the current object and edge selection. Tile 0, 0 is UDIM 1001. Conventional UDIM labels appear for U 0–9 and V ≥ 0. Coordinates elsewhere remain available by their signed tile indices.
4. Choose a resolution and line color, then download the transparent PNG. Use it as a guide layer in a texture painting application.

The layout preserves original n-gons and independent position and UV indices. A UV island joins faces through a shared position edge with the same texture indices at both ends. Duplicated UV indices define seams even if their coordinates coincide. Missing-UV faces are counted and skipped. The diagnostics count complete faces with near-zero signed UV area and faces with any UV outside tile 0, 0. Tile clipping preserves edges that cross a tile without rewriting the source coordinates. Density and overlaps require separate analysis.

The tool reads OBJ `o` names and polygon `f` records with absolute or relative indices. Files without named objects appear as one default object. Material, group, point, line and free-form surface records are outside the UV layout. Limits are 32 MiB, 200,000 positions, 200,000 UVs, 200,000 normals, 100,000 faces, 500,000 face corners and 1,000 objects containing faces. Replacing a file keeps the prior preview until the new OBJ has been parsed successfully.

The workflow follows Maya’s UV Snapshot selection, capture region, resolution and line-color controls. Musubi uses a browser-local tile preview and exports one square PNG at a time. [Autodesk Maya UV Snapshot](https://help.autodesk.com/cloudhelp/2027/ENU/Maya-Modeling/files/GUID-26F3DFAB-A6D9-4F9E-A11A-2BD9EF1C3DF1.htm)
