# Splat Crop

Open `/tools/splat-crop/` on the Musubi Motion development or production server. The tool crops a local Gaussian PLY capture in its source coordinate system. It runs in the browser and leaves the original file intact.

1. Choose **Open PLY**, or use **Load example** for a 6,144-splat synthetic capture with three clusters.
2. Drag a rectangle in Front (XY), Top (XZ), or Side (YZ) to set two pairs of bounds. The remaining axis keeps its previous bounds. Edit the six fields for exact values and press Enter or leave a field to commit. You can also middle-drag a field to adjust it live and release to commit. Escape cancels an unfinished edit. **Reset** fits the source extents, and **Undo** and **Redo** step through committed crop bounds.
3. Check the inside and outside totals. **Download inside** and **Download outside** each write a PLY for the corresponding nonempty region. Open either in Musubi Motion with **File → Import**.

Centers exactly on any box boundary belong to the inside. A splat can visibly extend across a boundary because its covariance stays intact. The views plot source centers with each axis fitted to its own extent, including sampled extrema. They display up to 24,000 centers, while the totals and exports use every source record. **Cancel** stops an active file scan or download preparation and retains the last accepted capture and bounds.

The tool accepts binary little-endian PLY 1.0 with an LF-only header, one vertex element and the scalar type names `char`, `uchar`, `short`, `ushort`, `int`, `uint`, `float` and `double`. The Gaussian properties `x`, `y`, `z`, `f_dc_0–2`, `scale_0–2`, `rot_0–3` and `opacity` must use `float` or `double`. The format supports 0, 9, 24 or 45 consecutive floating-point `f_rest_` properties starting at `f_rest_0`.

These header constraints follow the installed Spark 2.4 decoder. Export a standard Gaussian PLY if the source uses CRLF, scalar aliases such as `float32`, a complete `red`/`green`/`blue` triplet that Spark treats as a point cloud, ASCII, big-endian data, faces, lists or compressed chunks. The tool supports up to 256 MiB, four million records and 256 properties. It rejects payload size mismatches and centers outside the editor's finite coordinate range. Retained records keep their exact bytes and order, including spherical harmonics and extra scalar properties. Only the declared vertex count changes in the header. The source author remains responsible for the other Gaussian values carried through export.

The original 3D Gaussian Splatting implementation documents the Gaussian field names. The crop algorithm and example capture are original Musubi Motion code. [3D Gaussian Splatting model](https://github.com/graphdeco-inria/gaussian-splatting/blob/main/scene/gaussian_model.py) · [Spark 2.4 PLY decoder](https://github.com/sparkjsdev/spark/blob/v2.4.0/rust/spark-lib/src/ply.rs)
