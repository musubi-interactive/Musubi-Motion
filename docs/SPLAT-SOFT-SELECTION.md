# Sphere, radial and soft splat selection

Select one loaded splat object, press **F8**, and open **Splat Components**.
Choose **Sphere (3D world)** or **Radial (2D screen)** in Selection tool.

- **Sphere:** click an original center to place the sphere at its current posed
  world position. Drag from that click to set radius on the view plane through
  the center. You can also enter Sphere center XYZ and Sphere radius (world),
  then press Apply Sphere / Radial Region. The wire volume is in world space;
  distant points with the same screen position remain outside it. Sphere always
  uses the entire 3D volume, so screen depth filtering is disabled for this tool.
- **Radial:** click to place the 2D circle using Radial radius (px), or drag from
  its center to set the radius. Its circle and radius use CSS pixels. Through
  includes different depths at the same projected location; Front centers keeps
  the existing nearest-center-per-4px-cell approximation. It is not surface alpha
  or scene occlusion. Moving the camera changes the next radial scan.

Enable **Soft Selection** to use Linear, Smooth or Sharp falloff. Hard core
fraction holds the inner part at weight one; weights decrease toward the outer
radius. Blue-to-amber center markers show low-to-high weight. The displayed
sample is limited to 20,000 markers; operations include all affected IDs.
**B** toggles the current/next sphere or radial falloff outside Paint Selection;
in Paint Selection, holding B still resizes its existing brush. Ordinary
click/box/lasso/paint selections and set/mask recalls are hard membership.

Shift toggles membership, Ctrl/Command subtracts and Ctrl/Command+Shift adds.
For soft regions, addition takes the greater weight and subtraction takes
`max(0, old - incoming)`; toggling removes an existing member or adds the incoming
weight. Adjusting the last region's radius/core/curve recomputes from its captured
prior selection, so repeated previews do not accumulate weights. Switching tools
ends that region; it keeps the resulting membership and sampled weights.

Numeric radius/center/core edits preview live. Middle-drag a numeric field or
label to scrub, right-click for Lock/Unlock, and Escape to restore its original
settings, IDs and weights. Cancelled scans do not publish partial membership.
Selection and its controls create no scene undo history.

Press **W/E/R** for the existing Move/Rotate/Scale gizmos, or edit relative XYZ
fields in Transform Selected Splats. Every positive-weight member shares the
centroid pivot of the affected centers; the pivot does not move as a function of
weight magnitude. Translation uses weighted distance, rotation uses quaternion
slerp, and scale interpolates each captured tool-axis scale from one. The world
or object tool basis is captured once. Each full Gaussian covariance is changed,
including on skinned, edited or nonuniformly transformed objects. Zero weight
does not author a record; one weight takes the exact existing hard path.

Fractional reflections cannot pass continuously through an invertible scale:
they reject atomically with a message. Turn Soft Selection off for hard
reflection, or use positive scales. Zero/near-singular transforms retain the
existing atomic rejection. Preview always starts from the captured baseline;
Escape cancels exactly, and releasing a transform produces one undoable command.

Soft weights are sampled for a selection, then remain attached to stable original
IDs while the object is edited or animated. Reapply the region to resample its
current posed positions. Hidden/deleted/low-opacity originals are excluded;
generated elastic fill and LoD IDs never become component IDs. Selection,
falloff settings, regions, markers and GPU resources are transient and never
enter `.msb`; the resulting rest-space affine transforms persist normally.

Open `examples/splat-soft-selection.msb` for an original two-depth-layer study
with an authored weighted result and an unchanged instance sharing its source.
Regenerate using `node scripts/generate-soft-selection-fixture.mjs`.

Limits remain 1,000,000 selected originals, 100,000 transformed members per
gesture, 250,000 authored transformed records and 64 MiB unique-row transform
history. Oversized operations reject before authoring and preserve immediate
undo. Sphere radius supports 0.000001–1,000,000 world units, radial radius
1–16,384 CSS px, core 0–0.95 and centers within +/-1,000,000. Large scans yield
between chunks; a cancelled or superseded scan leaves the prior selection intact.

Functional reference: [Maya 2026 Soft Select components](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Basics/files/GUID-FF7C8670-97C7-4C13-9A6F-3B0A8F881EC9.htm).
Its contextual Tool Settings, B toggle, radius and gradient feedback map to the
Splat Components dock and existing transform toolbar. The bounded adaptation
provides explicit sphere/radial regions, numeric middle-drag radius editing and
three falloff presets; it does not implement geodesic surface propagation or an
arbitrary curve editor. No Maya icons, artwork or code were copied. Original
selection math, controls and fixture reuse installed Three.js 0.180.0/Spark 2.4.0
(MIT) and the existing CPU/GPU component pipeline; no dependency or format change.
