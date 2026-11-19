# Splat Crop

Open `/tools/splat-crop/` on the Musubi Motion development or production server. The tool crops a local Gaussian PLY capture in its source coordinate system. It runs in the browser and leaves the original file intact.

1. Choose **Open PLY**, or use **Load example** for a 6,144-splat synthetic capture with three clusters.
2. Drag a rectangle in Front (XY), Top (XZ), or Side (YZ) to set two pairs of bounds. The remaining axis keeps its previous bounds. Edit the six fields for exact values and press Enter or leave a field to commit. You can also middle-drag a field to adjust it live and release to commit. Escape cancels an unfinished edit. **Reset** fits the source extents, and **Undo** and **Redo** step through committed crop bounds.
3. Check the inside and outside totals. **Download inside** and **Download outside** each write a PLY for the corresponding nonempty region. Open either in Musubi Motion with **File → Import**.

Centers exactly on any box boundary belong to the inside. A splat can visibly extend across a boundary because its covariance stays intact. The views plot source centers with each axis fitted to its own extent, including sampled extrema. They display up to 24,000 centers, while the totals and exports use every source record. **Cancel** stops an active file scan or download preparation and retains the last accepted capture and bounds.

The tool accepts binary little-endian PLY 1.0 with an LF-only header, one vertex element and the scalar type names `char`, `uchar`, `short`, `ushort`, `int`, `uint`, `float` and `double`. The Gaussian properties `x`, `y`, `z`, `f_dc_0–2`, `scale_0–2`, `rot_0–3` and `opacity` must use `float` or `double`. The format supports 0, 9, 24 or 45 consecutive floating-point `f_rest_` properties starting at `f_rest_0`.

These header constraints follow the installed Spark 2.4 decoder. Export a standard Gaussian PLY if the source uses CRLF, scalar aliases such as `float32`, a complete `red`/`green`/`blue` triplet that Spark treats as a point cloud, ASCII, big-endian data, faces, lists or compressed chunks. The tool supports up to 256 MiB, four million records and 256 properties. It rejects payload size mismatches and centers outside the editor's finite coordinate range. Retained records keep their exact bytes and order, including spherical harmonics and extra scalar properties. Only the declared vertex count changes in the header. The source author remains responsible for the other Gaussian values carried through export.

The original 3D Gaussian Splatting implementation documents the Gaussian field names. The crop algorithm and example capture are original Musubi Motion code. [3D Gaussian Splatting model](https://github.com/graphdeco-inria/gaussian-splatting/blob/main/scene/gaussian_model.py) · [Spark 2.4 PLY decoder](https://github.com/sparkjsdev/spark/blob/v2.4.0/rust/spark-lib/src/ply.rs)

## Named regions

Open **Regions** in the Splat Crop workbench. **Add region** starts a named box from the current single-crop bounds. Select a region to edit its name, enabled state or bounds. Use **Earlier** and **Later** to arrange ownership priority. The projections highlight centers within the selected box and draw the other enabled boxes as outlines.

The first enabled box containing a center owns that record. **Overlap** counts centers inside two or more enabled boxes once each. **Remainder** counts centers outside every enabled box. Each region row shows its exclusively assigned count. Boundaries are inclusive on all axes.

The bounds use the same marquee and live numeric preview as Single crop. Right-click a number to lock or unlock middle-dragging. Each committed edit, including a priority change, can be undone or redone. Escape restores the exact bounds or name before an unfinished edit. Text fields retain native editing shortcuts. Use Ctrl+Z and Ctrl+Shift+Z or Ctrl+Y outside text fields, or Command+Z and Command+Shift+Z on macOS.

**Save recipe** downloads versioned JSON containing the ordered boxes, enable flags, full-source SHA-256, source byte length, vertex count and bounds. **Open recipe** checks every field and requires an exact match to the source capture. Renaming or moving the PLY is fine if its bytes match. A changed header, changed vertex attributes or changed bounds require the exact original capture or a new recipe. Failed and canceled operations keep the last accepted source and recipe.

**Download partition ZIP** includes **recipe.json**, **manifest.json** and a PLY for each nonempty region or remainder. The manifest lists the source fingerprint, overlap and every output count. Entries with zero records have a null filename. Each byte-exact source record appears once across the package, in original relative order within each PLY. Unzip the package and import the PLY files individually through **File → Import** in the editor.

The tool supports 32 named regions, 48 characters per name, 64 KiB recipes and a 260 MiB ZIP limit. Names are case-insensitively unique and use letters, digits, spaces, hyphens and underscores. **Remainder** and operating-system device names are reserved. Counts, hashing, record copying and ZIP writing run in a worker. **Cancel** stops the active operation. After canceling a count, use **Count again** or edit the regions to start a new count.

### Interaction references

The region list and separate bounds inspector follow the Outliner and Channel Box roles. The priority buttons expose order changes with mouse, keyboard or touch because row order determines record ownership. The three source-space projections provide direct box editing. [Maya 2026 node ordering](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Basics/files/GUID-545CC6FD-C0D7-48D8-A342-1042A9606566.htm) · [Maya 2026 attribute editing](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Basics/files/GUID-6F862011-4578-40A0-9902-786CA2A44AE5.htm)
