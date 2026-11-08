# Musubi scene files (.msb), scene version 2 / container version 1

Splat shapes may carry optional `componentTransforms: { version: 1, sourceCount,
records: [{ index, matrix }] }`. Records are ordered unique original source IDs;
`matrix` is a finite invertible column-major affine 4x4 rest edit, applied before
skinning. The current reader validates version, matrix conditioning, 250,000
scene-wide records and actual decoded source count before replacing the scene.
Original asset bytes remain embedded unchanged. Transient selection, component
pivot, previews and GPU tables are never archived. See
[component transform workflow](docs/SPLAT-COMPONENT-TRANSFORMS.md).

An `.msb` file is a standard ZIP or ZIP64 archive. New saves use STORE entries assembled as Blob references; legacy compressed ZIPs also remain readable. File > Save uses
the current file handle where supported. Save As requests a new destination.
Browsers without the native file picker download a named `.msb` copy instead;
the status says "Scene download started" because the app cannot confirm that
the browser finished writing a download. Open falls back to a file input.

Shortcuts: Ctrl/Cmd+S saves, Ctrl/Cmd+Shift+S saves as, Ctrl/Cmd+O opens.
New and Open ask before discarding unsaved document edits. The title's asterisk
tracks scene-document changes, including undo back to the saved state. Camera
navigation, selection, and playback do not mark the scene dirty. Camera and
timeline position are nevertheless captured whenever a scene is explicitly saved.
Failed/canceled saves retain the previous destination and unsaved state.

```text
scene.json
assets/<asset-id>
assets/<another-asset-id>
```

`scene.json` is UTF-8 JSON with this envelope:

```json
{
  "format": "musubi-project",
  "version": 1,
  "scene": { "format": "musubi-scene", "version": 2 },
  "editor": {
    "camera": { "position": [3, 2, 8], "target": [0, 0, 0], "fov": 42, "near": 0.01, "far": 1000 },
    "time": 0
  },
  "files": {
    "asset-id": { "path": "assets/asset-id", "sha256": "<64 lowercase hex characters>" }
  }
}
```

The shortened `scene` above stands for the full `SceneDocument` defined in
`src/scene-document.ts`: units, axis, ordered roots, node records, and asset
records. IDs, names, parent relationships, local transforms, and shape offsets
are preserved, along with optional joints, binding, elasticity, animation,
driven-key relationships, IK handles, and constraints. File assets retain their original names and byte lengths in
that document. Each file asset ID has exactly one ZIP entry and SHA-256 digest;
multiple shapes can refer to that same asset. A procedural `knot-v1` asset is
regenerated deterministically and needs no embedded file. Undo history, GPU
resources, UI theme/layout, selection, curve clipboard, auto-key toggle, playback
mode, and unkeyed pose overrides are not saved. Opening pauses playback.

## Animation and rigging extensions

The current scene format is `musubi-scene` version 2. The ZIP container remains
`musubi-project` version 1. This prototype intentionally drops scene version 1;
there is no dual reader or migration layer. All repository examples were
regenerated with scene version 2 while preserving their authored data. Unsupported
scenes fail before replacing the active document with: "Unsupported scene format
or version. This build opens musubi-scene version 2; recreate or re-export older
projects with a compatible build." Malformed current-format files also fail
atomically. Optional absent animation/rig fields retain authored fallbacks.

| Field | Stored data |
| --- | --- |
| `joints` | Joint IDs/names, parent IDs, local position, optional XYZ Euler `rotation` and `preferredAngle` in degrees |
| `SplatShape.binding` | Influence joint IDs, matching rest matrices, optional sparse `weights` |
| `SplatShape.elasticity` | Stretch/spacing/expansion, allocation budget, optional density/distribution, selected connection scope |
| `SplatShape.componentEdits` | Optional version 1, original `sourceCount`, and disjoint `hidden`/`deleted` arrays of start-inclusive, end-exclusive original-index ranges. Sorted, non-adjacent ranges per array; at most 16,384 combined. The decoded original count must match before the scene is installed. |
| `CurveShape` | `type: "curveShape"`, ID/name/parent ID, `degree`, weighted `points`, `knots`, `closed`, `color` |
| `MeshShape` | `type: "meshShape"`, ID/name/parent ID, `vertices` with stable IDs/local positions, `faces` with stable IDs/ordered vertex IDs, `color`, `shading`, `wireframe`, optional `skin`, `materials`, `uvs`, `uvSets`, `normals`, `morphTargets` |
| Mesh `skin` | `jointIds`, matching `inverseBindMatrices` (16 finite numbers each), and `weights` keyed by vertex ID with 1–4 normalized `{ joint: index, weight }` influences. Imported rest vertices are in the FBX bind frame; joint world matrices multiplied by inverse binds deform them before the mesh object's transform. |
| `ParticleShape` | `type: "particleShape"`, identity/parent, emission type/source, seed/timing, rate/lifetime, motion and fields, size/color/opacity endpoints |
| `animation` | `fps`, `start`, `end`, `loop`, `tracks` |
| Animation track | `id`, `targetId`, `channel`, ordered `keys` |
| IK blend track | Existing animation-track schema, handle `targetId`, `channel: "ik.blend"`; Base keys within 0–1, raw layer contributions use ordinary curve bounds |
| Curve key | `id`, `time`, `value`, `interpolation`, `tangentMode`, optional `inSlope`, `outSlope`, `inWeight`, `outWeight`, `broken` |
| `drivenKeys` | Relationship `id`, `driver` and `driven` property references, and curve `keys` |
| `ikHandles` | `id`, `name`, `rootId`, `endId`, world-space `target`, `enabled`, `iterations`, `blend`, optional `solver`, `poleTarget`, `targetControl`, `poleControl` |
| IK control link | Existing transform `objectId`, XYZ world-space `offset`; resolved point = evaluated transform world origin + offset |
| `constraints` | `id`, `name`, `type`, `sourceId`, `targetId`, `enabled`, `maintainOffset`, stored `offset`, optional `aimAxis`/`worldUpAxis` |

Each transform owns exactly one splat, controller curve, polygon mesh, or particle emitter shape. Curve shapes
need no asset record or binary entry; their parent transforms use the existing
animation and constraint channels. Curve degree is 1, 2, or 3. Each control point
is `[x, y, z, weight]`; there must be at least degree + 1 and at most 128 points.
Coordinates and knot values are finite within ±1,000,000; weights are positive
from 0.000001 through 1,000,000. The knot vector has point count + degree + 1
entries, is nondecreasing, has a nonempty active interval, allows multiplicity
up to degree + 1 at endpoints and degree in the interior, and separates distinct
values by at least 0.000000001. Interior continuity prevents false display bridges.
`closed` is a boolean and joins rendered endpoints without periodic conversion;
`color` is a six-digit `#rrggbb` string. Samples, line buffers, and selection
bounds are rebuilt at load time rather than saved. Existing splat-only archives
remain supported; older applications may reject the new shape type.

Polygon mesh shapes need no asset entry. They support up to 100,000 vertices and
100,000 faces, with 3–64 distinct existing vertex IDs per face. Positions are finite
within ±1,000,000. Component IDs are unique within the shape. Validation rejects
inconsistent winding, nonmanifold edges/vertex fans, zero-area faces, and polygons
that cannot be triangulated without self-intersection or degenerate triangles.
Validation first uses the dominant-axis projection, with an orthonormal frame
around the area-weighted face normal as a fallback for bent n-gons. Open
surfaces and empty meshes are valid. Intersections between separate faces are not
checked. `shading` is `flat` or `smooth`, `wireframe` is boolean, and `color` is a
six-digit hex string. Derived edges, triangulation, normals, selections, and GPU
buffers are rebuilt rather than stored. Older applications may reject mesh shapes.

Particle shapes store authored settings only, without live particles, GPU buffers,
solver state or replay caches. Surface emitters reference a mesh shape and must
be parented under its transform. Validation checks all references, finite field
settings, uint32 seeds, emission timing, and scene-wide particle budgets. Changes
to FPS must retain the maximum 300-second emission duration. See the exact bounds
in [the particle guide](docs/PARTICLES.md#limits). Reopening deterministically
replays to the saved timeline time. Older builds may reject the new shape type.

Optional `binding.weights` stores `{ count, overrides }`. `count` is the
nonnegative safe-integer count of original splat components, excluding generated
elasticity fill. `overrides` maps canonical decimal indices such as `"0"` and
`"12"` to arrays of `{ jointId, weight }`. Each row has one through four unique
bound joint IDs, strictly positive finite weights no greater than one, and a
total within 0.00000001 of one. Indices must be less than `count`; leading-zero,
fractional, negative, and unsafe-integer keys are rejected. Each shape supports
at most 200,000 stored overrides; a single editing command accepts at most
20,000 component indices.

Missing rows retain the existing automatic nearest-four inverse-squared-distance
weights. Authored weights retain floating-point precision in JSON; Spark packs
them to 8-bit values for rendering. Loading checks the stored count against the
decoded source before attaching skinning. A mismatch rejects the load rather
than applying weights to different components. Resetting overrides restores
automatic weighting. Original asset bytes are unchanged, and generated fill
inherits weights through the existing elasticity pipeline.

Property references contain `targetId` and `channel`. Channels are
`position.x/y/z`, `rotation.x/y/z`, `scale.x/y/z`, and `visibility`; joints do not
support scale channels. Key interpolation is `step`, `linear`, or `bezier`.
Tangent modes are `auto`, `clamped`, `flat`, `spline`, or `fixed`. Slopes use
value units per horizontal unit. Weights are fractions of the adjacent key
interval; absent weights default to one third.

Animation key `time` values are frame coordinates. Driven-key `time` values are
driver attribute values and can be fractional or negative. Neither curve type
uses the editor's saved time as its key coordinate. `editor.time` continues to
mean **seconds**, preserving the older archive convention. It now accepts signed
finite values up to an absolute 1,000,000 seconds instead of being restricted to
the old 12-second turntable. The UI restores the saved time within the scene's
playback range. Camera view/orthographic height remain optional extensions.

Animation validation requires valid targets/channels, finite bounded numbers,
ordered unique key coordinates, unique track/key IDs, and one track per target
channel per layer. Frame rate is 1–240; start/end are within ±1,000,000 frames and end must
be greater than start. Curve values and slopes are bounded by an absolute
1,000,000,000,000, except that Base `ik.blend` key values must be within 0–1;
weights are within 0–1. There may be at most 100,000 animation
keys in total and at most 100,000 driven keys in total.

Optional `animation.layers` contains at most 1,000 records with unique `id`,
`name` (1–200 nonblank characters), `mode` (`additive` or `override`), `weight`
(0–1), and boolean `mute`, `solo`, `locked`. Array order defines composition.
Optional `animation.activeLayerId` references an existing layer; absence means
Base. A track's optional `layerId` assigns it to that layer, otherwise Base.
A layer may own one optional `weightTrack: { id, keys: CurveKey[] }`. Its IDs
share the global pose-track/key namespaces and the 100,000-track/100,000-key
budgets. Values must be finite and within 0-1; key times are unique, sorted and
in ordinary fractional frame units. Unknown weight-track ownership fields are
rejected. Curves use the ordinary interpolation/tangent metadata. Their sampled
value is `clamp01(evaluateCurve(keys, frame) ?? layer.weight)`, holding endpoints;
missing/empty curves use the static fallback. Commands remove empty curves,
retain the fallback on clear, and honor the owner layer lock. These independent
tracks cannot target a pose, an SDK channel, or another weight.
Track/key IDs and total budgets remain global. Raw layer values use the ordinary
finite curve bounds; effective scale/visibility/IK blend clamp after composition.
Current-format scenes without these optional fields use authored fallbacks.

Joints optionally store `orientation: [x,y,z]` in finite XYZ degrees and boolean
`showLocalAxes`. Missing orientation is identity; local quaternion is orientation
multiplied by channel rotation. Mirror operations create ordinary joint records
and optional time curves, requiring no separate mirror schema. Influence edits
use the existing binding palette/rest matrices and weight override records.

Driven graphs permit one driver per output, reject property cycles, and reject
outputs that also have time curves. Relationship count is capped at 10,000.
Stored driven scale keys must be positive (at least 0.001), and visibility keys
must be within 0–1. The runtime also clamps interpolated scale/visibility outputs.
SDK supports only transform/joint pose properties; neither driver nor output
may reference `ik.blend` or an IK handle.

Joint `preferredAngle` is an optional dense finite XYZ Euler triple in degrees,
validated like `rotation`. Missing preferences preserve existing FK-based IK
seeding. Stored preferences seed solved links for both solvers; they do not change
authored FK channels, bind matrices, joint orientation, or the effector's local
rotation. This additive field needs no archive version change. The
[preferred-pose study](examples/preferred-ik-motion.msb) exercises persistence.

IK validation requires a root-to-descendant joint chain with nonzero authored
segment lengths, finite targets, blend within 0–1, and 1–128 iterations. It caps
handle count at 128 and rejects oversized chains, overlapping chains, and chains
controlled by another handle's ancestor. Deleting targets removes affected
animation/driven relationships; deleting relevant joints also removes affected
IK handles. History restores those records together on undo.

An omitted `solver` means legacy CCD; `two-bone` requires exactly three joints and
a finite `poleTarget`. Optional `targetControl`/`poleControl` links animate those
points through existing transform tracks or driven relationships, without changing
the archive version. Link IDs must name transforms, not shapes or joints; offsets
and resolved IK coordinates are finite XYZ values within ±1,000,000. Literal
`target`/`poleTarget` values remain fallback snapshots. Binding or creating a
control captures the current point, and unlinking captures the current resolved
point. Deleting a linked control keeps the handle and removes the link: viewport
deletion freezes the evaluated point; pure document deletion without evaluated
poses uses the saved literal fallback. Undo restores the linked records together.

Every configured link participates in dependency validation, including disabled
handles, zero blend, disabled constraints, and pole links retained on CCD handles.
The prerequisite closure follows linked controls, hierarchy ancestors, constraint
sources, and linked-chain root ancestors. Feedback through any IK chain is
rejected. Constraints in this closure run before IK; remaining constraints run
after it. SDK reads its pre-IK channels. Scenes without links retain the legacy
animation → SDK → IK → constraints order. Solver properties remain static.

An optional animation track with `targetId` equal to a handle ID and channel
`ik.blend` animates its FK/IK blend. Handle IDs must be distinct from node and
joint IDs. Pose channels cannot target a handle, and `ik.blend` cannot target a
node or joint. Evaluation samples this scalar separately from pose maps at the
requested frame; missing or empty blend tracks use the handle's saved `blend`.
Interpolated overshoot is clamped to 0–1 without rewriting the curve. The Graph
Editor still displays the raw curve; shape-preserving insertion at an out-of-range
sample rejects rather than authoring an invalid key. Existing files with literal
blend only keep their behavior, and the MSB container version remains 1 (current scene version 2).

FK matching adds a zero key to an existing blend track at the captured frame;
without that track it changes the literal fallback to zero. The joint rotation
keys and blend change share one undo step. Deleting a handle or a joint chain
that removes it also removes its blend tracks atomically; undo restores both.

Constraint types are `point`, `orient`, `aim`, `scale`, and `parent`. Offsets contain
position and scale XYZ tuples plus a normalized XYZW rotation quaternion.
Offsets and endpoints are captured at creation; enabled/name may be changed
later. There may be at most 10,000 constraints. Validation rejects missing
targets, self/hierarchy/dependency cycles, invalid offsets, joint scale outputs,
and multiple owners of the same position/rotation/scale group. Disabled records
still participate in cycle/ownership validation. Parent owns position and
rotation; it does not own scale. Removing a source or target removes its
constraints, and undo restores them with the scene.

Aim records may specify `aimAxis` and `worldUpAxis` as `+X`, `-X`, `+Y`, `-Y`,
`+Z`, or `-Z`; omitted values default to `+Z` and `+Y` respectively. The local
up direction is derived: +Y except for a ±Y aim axis, which uses +Z. Aim owns
rotation and stores a maintained orientation offset in the existing quaternion
field. It does not add a target node or alter local translation/scale. Enabled
aim constraints reject coincident world positions within 0.00000001 scene units.

Creation checks the supplied current pose; archive validation checks axes,
references and affine restrictions in the authored pose. Aim coincidence is
checked during creation and evaluation, since animation can separate coincident
authored origins. Runtime affine checks are also necessary because valid data
can animate into unsupported transforms. Orient/aim/parent/scale require
uniformly scaled driven parents; orient/parent/scale require nonsheared sources.
Aim reads only the source position. Point permits arbitrary finite invertible
parents. Non-finite values and singular driven parents are rejected. A runtime
failure stops playback with a notice and leaves the input time/preview/SDK pose
intact. Prerequisite constraints, IK, and remaining constraints form one atomic
rig stage, so a failure retains none of its partial results. This check does not
remove the saved constraint; it can be disabled
or deleted to repair the scene.

The loader validates format versions, IDs, references, unique sibling names,
hierarchy cycles, roots, transform values, shape counts, camera values, asset
inventory, byte lengths, SHA-256 digests, and the optional animation/rigging
records above. Unsupported generators and node
types are rejected. Scene version 2 matches the current editor's one renderable shape per
transform; group-only nodes and instancing of DAG nodes are not implemented.

All meshes are prepared in a staging collection. The old scene and history stay
active until preparation succeeds. A malformed archive or a splat decoding
failure leaves the current scene intact. Successful Open/New clears old history
and releases old runtime objects. No network asset downloads occur during Open.

## Limits and future work

- Asset data and archives have no fixed application byte cap. Assets use chunked CRC32/SHA-256 and Blob slices/references. JSON metadata remains capped at 128 MiB and scene nodes at 10,000. These are guardrails,
  not a performance guarantee: actual memory includes staging and GPU data too.
- Saves use ZIP STORE entries because splat files often have their own
  compression. Each save rewrites the portable package. Streaming/project-folder
  saving should precede support for very large assets.
- The filename extension is `.msb`; it does not imply Maya binary compatibility.
- Autosave, incremental backups, reusable scene references, and schema migration
  are future work. Unknown versions fail explicitly instead of loading partially.

## Verification

`npm test` covers archive round trips, original asset bytes, IDs and transforms,
empty scenes, missing/corrupt assets, invalid hierarchy, unsupported versions,
file-handle reuse, failed writes, and cancel behavior. Browser checks exercised a
real `.msb` download and reopening it after New, with both procedural and imported
splats, plus restored non-uniform transforms and dirty-state undo. Native handle
protocols are tested with mocks; the OS save dialog is not automated.

The animation and driven-key suites additionally cover extended metadata
roundtrips, malformed keys/dependencies, and deletion cleanup. A representative
portable scene is included at [examples/animation-study.msb](examples/animation-study.msb);
its source is [scripts/create-animation-example.mjs](scripts/create-animation-example.mjs).

[examples/animated-ik-controls.msb](examples/animated-ik-controls.msb) exercises
linked target/pole transforms, their position curves, and constrained input parents.
Its [generator](scripts/create-ik-controls-example.mjs) verifies 241 half-frame
samples before and after archive readback with endpoint error below 1.7 × 10⁻⁸
scene units, and checks the shared historical pose sampler.

[examples/animated-ik-blend.msb](examples/animated-ik-blend.msb) adds handle blend
tracks and FK rotation curves. Its [generator](scripts/create-ik-blend-example.mjs)
checks 241 half-frame samples against quaternion interpolation and historical
sampling before and after archive readback; intermediate blend is not expected
to place the endpoint exactly at the IK target.

[examples/baked-ik-motion.msb](examples/baked-ik-motion.msb) stores the same rig
with sampled linear joint rotation keys and `enabled: false` on its IK handle.
Target/pole links and the original blend curve remain saved. Baking introduces
no new archive fields or version change. Its
[generator](scripts/create-ik-bake-example.mjs) compares world poses at sampled
frames before and after readback and measures approximation between samples.

### Imported mesh appearance and blend shapes

Mesh materials store Standard material settings and raster texture data URIs (never remote URLs or blob references). UVs, additional UV sets, and source normals map vertex IDs to coordinates. Faces optionally reference a material slot with `materialIndex`. `morphTargets` contain a name, default weight, and per-vertex position deltas in the same bind frame as the mesh. Animation channels `morph.N` target the owning transform and animate the corresponding weight; morph displacement is applied before skinning. Older builds may discard these optional extensions when resaving.

### Object pivots

Transform nodes optionally store `pivot` and `pivotCompensation` as finite local XYZ vectors, defaulting to zero. Their evaluated matrix is `T(position + pivotCompensation + pivot) * A * R * S * T(-pivot)`. Relocating a pivot balances compensation at the current evaluated pose, preserving geometry and descendants while leaving existing keys intact. Subsequent rotation and scale evaluate around the newly authored pivot.

Transform nodes may also store `affine`: a finite nonsingular orientation-preserving column-major 3×3 matrix A, defaulting to identity. This retains the full geometric effect of world-axis scaling on rotated objects. Pivot relocation compensation uses `(A*R*S - I) * deltaPivot`. Rendering, hierarchy/world matrices, and saving retain A; older builds without this extension may not reproduce affine objects.

### Converted mesh parts and viewport visibility

Transform nodes may store `hidden: boolean` (default false), an undoable viewport visibility override applied alongside animated visibility without changing keys. Splat bindings may store `meshSpace: boolean` (default false). In meshSpace mode, the local deformation is the weighted sum of `jointWorld * inverse(restMatrix)`; the owning object transform is applied afterwards, matching imported polygon mesh skinning. Converted bind matrices are the inverses of the source mesh inverse binds, and sampled weights persist by splat index. Legacy bindings retain world-relative deformation.

## Reusable texture assets (additive scene version 2 extension)

`scene.textureAssets` optionally maps `tex_<SHA256 of original image bytes>` to a
record containing `id`, `name`, `mime`, `byteLength`, `width`, `height`, `alpha`,
`role` (`color` or `data`), `dataURI` (immutable original raster bytes), and
`thumbnail` (embedded PNG, at most128px). Each original appears once in this
shared registry. A mesh material texture stores exactly one source: an existing
embedded `dataURI`, or an `assetId` referencing this registry. Sampler fields are
unchanged. The current validator verifies content IDs, image bounds and all
material references. The browser stages image decoding before committing an open.
Standalone library entries survive deletion of their former scene users. Undo
history, library selection and pending import/replace previews remain transient.
The scene/container version identifiers remain2/1; no legacy migration is added.
See [Texture Assets](docs/TEXTURE-ASSETS.md) for bounds, color/data semantics,
replacement/relink behavior, provenance and the original portable example.


## Boolean and Enum custom attributes

Existing optional scene `customAttributes` definitions accept `type: "boolean"`
or `type: "enum"`; missing/`float` preserves the original numeric representation.
Boolean values are 0/1. Enum definitions carry ordered `entries: [{id,name,value}]`
and monotonic `nextValue`. IDs and permanent integer codes remain stable across
label/order edits; authored time/SDK curves reference those codes, never UI
ordinals. Codes cannot be reused or renumbered. Entries/labels/limits/defaults,
Step interpolation and references are validated before publication or open.
No scene/archive version change. See [typed attribute workflow](docs/CUSTOM-ATTRIBUTE-TYPES.md).
