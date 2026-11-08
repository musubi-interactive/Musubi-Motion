# Move, rotate and scale splats

Select a loaded splat object and press **F8** (or Select > Splat Components).
Use click, box, lasso or Paint Selection to choose visible original splats.
Shift toggles, Ctrl/Command subtracts, and Ctrl/Command+Shift adds regions.
Press **W**, **E** or **R** for Move, Rotate or Scale; **Q** returns to selection.
The existing viewport World/Object menu controls the axes. Selected centers
share a centroid pivot. Rotation and scaling change the full Gaussian,
including off-axis anisotropy, rather than only its center.

The **Splat Components** dock offers relative Move, Rotate (degrees) and Scale
XYZ fields. Values reset to 0/0/1 after a command. Typing previews live; Enter or
blur commits. Middle-drag a field or axis label to scrub; right-click offers
Lock/Unlock. Escape cancels a draft or gizmo gesture. Pointer cancellation and
window focus loss cancel a drag. Release creates one undo step. Native text
editing and native field undo retain focus priority.

Hidden and deleted splats cannot be transformed or selected. Show/Restore keeps
their transforms. Selection, pivot, highlights and GPU resources stay outside
archives. Open `examples/splat-transform-study.msb` for three edited SH1
ellipsoids beside an unchanged instance sharing the source. Regenerate with
`node scripts/generate-splat-transform-fixture.mjs`.

## Evaluation and limits

Optional shape-owned version-1 `componentTransforms` stores decoded original
source count and ordered sparse original-index affine matrices. Source bytes,
opacity, RGB, SH coefficients, skin weights and animation keys remain unchanged.
SH retains its authored source basis, matching existing Spark source appearance.
Covariance transforms by **A C Aᵀ**. Unselected records follow the original
evaluation path without transformation.

Order is original Gaussian, component rest edit, linear skinning, object/world
transform. Elasticity computes strain from edited rest centers. Its existing
source-axis stretch applies to original Gaussian axes before the affine edit.
Generated fill uses edited endpoint ellipsoids and existing interpolated
scale/orientation; generated IDs are not editable original components.
Original SH remains intact; fill retains the existing RGB/zero-SH policy.
CPU selection, object rays and bounds use the same affine ellipsoid factors as
the renderer. Future soft selection shares this pivot and immutable source
weights; this task uses hard membership with weight 1.

In a posed object, world gesture D authors **B⁻¹ W⁻¹ D W B** for each selected
member, with its actual quantized linear-skin blend B and mesh world matrix W.
The rest edit then follows later animation. Singular/nearly singular poses,
zero/invalid scales, invalid IDs and out-of-range results reject the entire
operation with a message and no partial change.

Ceilings: **100,000 selected splats per gesture**, **250,000 transformed splats
per scene**, **64 MiB component-bearing undo payload** (conservative 192-byte
accounting per unique immutable record, counting shared rows once). Oldest
steps expire when that budget is reached; the immediate undo is retained.
If an edit and its immediate prior state cannot fit together, the operation
rejects atomically before authoring; select a smaller region or undo prior edits.
The UI shows limits before editing and never truncates selection. Unchanged
rows share history storage. A 100,000-row GPU table occupies 6,406,144 bytes;
tiled RGBA32F lookup uses exact 16-bit index words and bounded binary search.
Original-index edits disable automatic LoD for that instance. Validation,
CPU bounds/picks and uploads can pause large edits; this is a bounded prototype.

## Maya mapping and provenance

Maya 2026 [Scale objects and components](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Basics/files/GUID-09D0E733-74DF-44E2-937A-C857001E45B2.htm)
defines the selected-component center pivot and R tool.
[Precise values](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Basics/files/GUID-EB585085-9C14-444F-8ACD-ECB087286FDF.htm)
maps to contextual XYZ fields. W/E/R reuse Musubi's existing toolbar and operation
icons. F8/Q preserve mode/select conventions; World/Object reuses the existing
axis selector. Browser adaptation: relative component XYZ fields in the dedicated
dock rather than absolute object channels. The pivot is transient and centered;
custom component pivot editing is outside this bounded task. No Autodesk artwork,
code or new icons were added.

Original implementation and procedural data reuse installed Three.js 0.180.0
and Spark 2.4.0 (both declare MIT), existing Zustand/Zundo history and current
MSB/scene formats. No dependency, external dataset, service or model was added.
