# Animation and rigging guide

Musubi implements a practical subset of Maya-style animation workflows. The
current editor has a frame timeline, editable transform/joint curves, driven
keys, FK, CCD and analytic two-bone IK with pole targets, numeric and painted skin
weights, and point/orient/aim/scale/parent constraints. Targets and poles can use
animated curve controls and additive/override animation layers. Polygon tools and
particle FX have separate [modeling](MODELING.md) and [particle](PARTICLES.md) guides.

## Start with the example

Choose **File → Open scene** and open
[examples/animation-study.msb](../examples/animation-study.msb). This small portable
scene uses procedural assets, so it needs no external splat file. It contains:

- An **Animated study** knot with a keyed bounce and a 720-degree spin.
- A **Driven study** knot whose Z rotation responds to the first knot's Y position.
- A **Shoulder → Elbow → Wrist** joint hierarchy with keyed shoulder FK motion.

Play or scrub frames 0–96. Choose the **Animation** workspace preset to inspect
the curves, then open **Animation → Set Driven Key** to inspect the response.
The example has no binding or IK handle preset. In the IK controls, choose
Shoulder as root and Wrist as end to try a three-joint chain.

Regenerate this example from the repository root with:

```sh
node scripts/create-animation-example.mjs
```

The script uses the application's own document/archive modules and the existing
Vite dependency. It does not download assets or introduce a service dependency.

For linked IK, open [examples/animated-ik-controls.msb](../examples/animated-ik-controls.msb).
Its analytic chain follows keyed target and pole controls while a constrained
root moves. Inspect frames 0–120 and the controls' position curves. Regenerate it
with `node scripts/create-ik-controls-example.mjs`. The generator evaluates 241
half-frame samples both before and after native archive readback, with maximum
endpoint error below 1.7 × 10⁻⁸ scene units, and checks the historical pose sampler.
These are reproducible model checks, not a browser playback measurement.

[examples/animated-ik-blend.msb](../examples/animated-ik-blend.msb) extends that rig
with keyed FK shoulder/elbow rotations and a linear blend of 0 at frame 0, 1 at
frame 60, and 0 at frame 120. Rebuild it with
`node scripts/create-ik-blend-example.mjs`. Its verifier checks 241 half-frame
samples before and after archive readback against an independent local-quaternion
blend expectation and the historical pose sampler. Partial blend mixes joint
rotations; the end joint intentionally need not reach the target until full IK.
The generated archive measured a maximum quaternion angle error of about
5.2 × 10⁻⁸ radians; the constant-one IK reference reached its target within
1.1 × 10⁻¹⁴ scene units. Historical world matrices matched exactly at the sampled
frames, including after archive readback. These are model checks, not browser
verification or a guarantee for every rig.

## Workspaces and panels

The workspace selector offers **General**, **Animation**, and **Rigging**. A
preset rearranges existing panels; it does not create a separate scene. Animation
opens the Graph Editor, while Rigging opens the rigging tools. Dockview tabs can
be dragged, combined, closed, and resized. The layout is saved in local browser
storage, outside the `.msb` project.

Open **Graph Editor**, **Dope Sheet**, and **Set Driven Key** from the **Animation**
menu. Outliner and Properties remain the selection and local-channel controls.
Use **View** to reopen the standard panels. Modeling and FX presets expose their
dedicated mesh and particle tools.

## Keyframe an object or joint

1. Select an object or joint in the Outliner or viewport.
2. Leave Timeline **Mode** set to **Animation** and choose the current frame.
3. Edit Position, Rotation, or Scale in Properties, or use the viewport gizmo.
   Joint scale is not supported.
4. Press **S** outside text fields, or click **Set key · S**. This keys the
   selected transforms/joints at the current frame.
5. Move to another frame, change the pose, and set another key. Scrub or play to
   inspect the result.

The initial range is 0–288 at 24 FPS. Timeline **Start**, **End**, **FPS**, and
**Loop** are saved with the scene and support undo. Frame navigation snaps to
whole frames; playback evaluates subframes. Keys outside the playback range are
retained. The slider's markers show keyed frames for the current selection.
Click a marker to seek to it. **Delete keys at frame** removes the selected
objects' keys at the current rounded frame.

**Auto key** modifies existing animated channels when their displayed values
change. Set the first keys with **S**; enabling auto-key does not create tracks
for an entirely unkeyed object. Driven output channels are excluded from manual
transform keying and auto-key. The auto-key toggle is an editing preference for
the session, rather than a scene animation layer.

Properties has a diamond beside each transform channel. Click it to key just
that channel's displayed value. An empty diamond means no curve, a filled
diamond means an animated channel, and a gold diamond means a key at the current
frame. Joint scale and SDK-driven outputs cannot be keyed there. The **Visible
(key at current frame)** checkbox directly authors a stepped visibility key;
its diamond keys the existing visible/hidden value without toggling it.

An edit to an already animated transform/joint channel without auto-key is a temporary pose
override until it is keyed. Scrubbing or starting playback resumes the curve.
Authored base channels still participate in ordinary document edits, but saving
does not turn that temporary pose into animation keys. Set the key before leaving
the frame when you intend to keep the animation change.

**Space** toggles playback; **,** and **.** step one frame backward/forward.
Rewind seeks to the playback start. The separate **Turntable preview** mode
retains the original 12-second presentation rotation. Turntable playback is not
a keyframe curve and is not saved as animation.

## Animation layers

Open **Animation → Animation Layers**. Base animation evaluates first. Additional
layers evaluate in list order; **Earlier/Later** reorder them. Add, rename, remove,
choose Additive/Override, set weight 0–1, mute, solo or lock. Base stays under solo
layers; muted solo layers do not suppress others. Layer selection changes the
editing destination, not playback, and is saved with the project.

Additive position and XYZ Euler rotation curves contain offsets. Additive scale
curves contain factors, with 1 neutral. Override curves contain target values.
Visibility uses held scalar override blending, followed by the viewport's 0.5
threshold. Missing channels pass through. Scale stays positive and effective IK
blend stays within 0–1 after mixing; raw layer contributions can exceed these
effective bounds. These are scalar Euler layers, not quaternion rotation layers.

Timeline keying, Auto Key, channel diamonds, Graph Editor, Dope Sheet and rotation
cleanup operate on the active layer. Keying solves the raw contribution needed to
produce the requested composite pose; muted, zero-weight, locked, solo-excluded or
fully masked destinations reject unachievable edits. Unkeyed layered pose edits
are temporary previews and do not overwrite authored base transforms. Auto Key
updates existing active-layer channels only. Copy/paste transfers raw values into
the active layer, so pasting between blend modes may change the resulting pose.

SDK channel ownership applies across every layer, including muted layers. Layered
IK range baking creates a top override layer and retains the original tracks;
the same sampled whole-scene verification runs before committing. As before,
disabling the IK handle affects the entire timeline and outside-range motion may
change. Layer settings remain static. Layer weights support an independent saved curve.
Merge/flatten and per-object layer membership tools remain future extensions. Limits: 1,000 layers,
100,000 total tracks and 100,000 total keys. Weight curves share both budgets with pose tracks.

In **Animation Layers**, **Fallback weight** is the saved static value used when
there is no weight curve. **Sampled weight** reports the curve at the current
fractional frame. Set **Weight key value** and press **Set weight key** to key the
rounded current frame. **Delete weight key** removes that frame; deleting the last
key removes the curve. **Clear weight curve** restores the fallback without
changing it. New weight keys use linear interpolation; replacing an existing key
preserves its ID and tangent metadata. Weight curves hold their endpoints and
clamp sampled Bezier overshoot to 0-1. A zero-weight solo layer still excludes
non-solo layers; Base always passes through.

Weight commands target their owning layer directly, so zero influence does not
prevent weight keying. Locking the owner prevents edits to its weight/curve.
The right-aligned numeric fields support Enter/blur, Escape restoration,
middle-mouse scrubbing and contextual field Lock/Unlock. Scrubbing these fields
only changes the local field until release; **Weight key value** remains a draft
until **Set weight key**. Each fallback edit or curve command is one undo step;
no-op commands add no history. Playback changes neither document nor history.
Weight tracks are separate from pose tracks and are deliberately excluded from
generic Graph Editor, Dope Sheet, SDK drivers and SDK outputs in this slice.

This follows Maya 2026's [layer-weight keying workflow](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Animation/files/GUID-59E7CD71-66EC-4200-8467-7B785B85A7A6.htm)
in the dedicated layer panel. Separate fallback/sample displays make the stored
fallback explicit; generic weight-curve editors are a later extension.


Open [examples/layered-rig-study.msb](../examples/layered-rig-study.msb) for joint
orientation, additive arm adjustment and keyed mirrored poses on an override
layer. Regenerate with `node scripts/create-layered-rig-example.mjs`.

### Merge animation layers

Open **Animation Layers → Merge Layers…** and check two or more unlocked source
layers. Checkboxes select the merge sources independently of the **Active layer**
field used for keying. Set **Start frame**, **End frame**, and **Sample By**.
Both endpoints are included. The sample interval is in scene frames and accepts
fractional values. The numeric fields support right-aligned input, middle-drag,
and contextual Lock/Unlock. The options open with keyboard focus on a source
checkbox. **Cancel** and Escape discard the preview and return focus to the
merge button.

**Preview Merge** validates the sources and reports the new layer, curve and
key counts, and maximum checked channel error. **Bake Layers** replaces the
selected layers with a weight-one override at their lowest stack position and
makes it active for ordinary Graph Editor and Dope Sheet edits. Bake is one
undoable edit. Undo restores the original source layers, their keys and weights,
and the previous active layer. Redo restores the baked layer.

For each contributing channel, the bake samples Base and the enabled stack
through the last selected layer using their current blend and animated weights.
Base and every nonselected layer keep their authored records and order. The
baked override captures the lower stack's sampled values for those channels,
so later edits to Base or a layer underneath it can be masked. Layers above the
sources still apply in order. An unselected layer between the sources may
remain when it keys separate channels. Merge stops if it overlaps a channel
being baked. The current mute and solo state applies, including zero-weight
solo layers. A statically zero-weight source supplies no curves. An animated
weight contributes wherever its sampled value is nonzero. Source layers are
removed as a whole, and the baked curves hold their endpoint values outside the
sampled range.

Continuous curves use linear segments with extra keys at source key times,
weighted Bezier extrema, and where probes require a closer fit. Rotation preserves unwrapped local Euler
components, including whole revolutions. Visibility and discrete attributes
use Step keys. The check compares the original and baked stack at each accepted
segment's quarter, half, and three-quarter positions, plus positions immediately
inside Step segment boundaries for discrete channels, with tolerance
`0.001 + 0.000001 × abs(original)` in channel units. It also checks the final
visibility threshold and exact Boolean or Enum values at those positions.
For Visibility, Boolean and Enum curves in the captured stack, animated layer
weights must use Step interpolation within the bake range. This keeps every
discrete change aligned with an explicit key time. Layers above the baked
override can still use continuously animated weights on those channels.
Between the checked positions, playback follows the baked curves. If the
preview cannot satisfy the checks, it leaves the scene unchanged.

Set Driven Key drivers or driven properties, IK blend, and transforms that
feed enabled IK or constraints are outside this bake. The preview can sample
up to 10,000 regular frames and produce up to 25,000 keys, with a 300,000 source
curve evaluation limit and the normal scene animation limits.

The options follow Maya 2026's [Merge Layers workflow](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Animation/files/GUID-9656522D-ED3B-4FAA-AA95-5167A7AC3482.htm)
and its [Sample By and bottom placement options](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Animation/files/GUID-C7987782-C10D-433C-A78D-94C10D800608.htm).
Musubi uses a text-labeled monochrome button for the options, an explicit
preview, and an override result for the sampled stack.

Open [examples/layer-flatten-study.msb](../examples/layer-flatten-study.msb),
select **Animated Accent** and **Shape Override**, and bake frames 0–24. Keep
**Retained Finish** to see how the upper layer still affects rotation.
Regenerate the source with `node scripts/create-layer-flatten-example.mjs`.

## Graph Editor

Select a channel in the list to make its curve active. **Selected targets**
filters the list to selected objects, joints, and IK handles. Curves use local
transform units, degrees, or unitless IK blend, with labelled frame and value axes.
Handle rows show the handle name and **IK blend**; channel rows and Dope Sheet
labels can select that handle without selecting a draggable target marker.

| Action | Control |
| --- | --- |
| Select a key | Click its diamond |
| Add/remove keys from selection | Shift-click |
| Select keys in a rectangle | Drag blank graph space; Shift adds to selection |
| Move selected keys | Drag a key; frame coordinates snap to whole frames |
| Edit one key precisely | Frame and Value fields |
| Insert without changing curve shape | Insert key or focused-editor S, at the current frame |
| Author a key at a chosen time/value | Double-click the graph |
| Delete selected keys | Delete button, Delete, or Backspace |
| Copy/paste | Toolbar or Ctrl/Cmd+C and Ctrl/Cmd+V |
| Zoom around the pointer | Mouse wheel |
| Pan | Alt-drag or middle drag; Shift-wheel pans time |
| Frame keys | Frame all / Frame selected; F uses the current key selection |
| Nudge key times | Left/right arrow; Shift changes the step to 10 frames |
| Select all visible keys | Ctrl/Cmd+A |
| Cancel a graph drag / clear key selection | Escape |

Paste offsets copied keys so the earliest copied time lands on the current
frame. It preserves their original object/channel destinations; this is not
animation retargeting. Moves and time scaling that create conflicting key times
are rejected atomically. A completed key or tangent drag is one undoable edit.

IK blend supports the same key selection, retiming, copy/paste, interpolation,
and tangent tools. Its keys must remain within 0–1. The graph shows raw tangent
overshoot while playback clamps effective blend. **Insert key** rejects an
overshoot sample that would require an out-of-range key to preserve the curve;
adjust the tangent or author a valid value instead. With no active curve, a
selected IK handle can start its blend curve using **Insert key**.

**Insert key** samples the active curve at the current frame and preserves its
shape. Linear and stepped intervals retain their existing interpolation; Bezier
intervals are subdivided with De Casteljau interpolation, including ordinary
weighted handles. Affected neighboring tangents become Fixed so their adjacent
segments retain the same shape. The insertion and tangent changes form one
undoable edit. Double-clicking an explicit time/value instead performs ordinary
key authoring and may change the curve.

Some extreme weighted splits would require infinite tangent slopes or handle
weights greater than one, which the saved curve schema cannot represent. Those
insertions are rejected atomically with an instruction to adjust tangent weights;
the editor does not substitute an approximate curve.

Choose **Bezier**, **Linear**, or **Stepped** interpolation. Bezier keys expose
incoming/outgoing handles on the active curve. Drag a handle or edit **In slope**
and **Out slope**. **Break tangents** permits independent directions; linked
handles share a slope. **In weight** and **Out weight** set handle lengths as
fractions of adjacent key intervals; **Unweight** resets each to one third.

Tangent presets are **Auto**, **Clamped**, **Spline**, **Flat**, and **Fixed**.
Auto limits slopes and flattens extrema; Clamped flattens plateau transitions;
Spline uses the neighboring-key slope; Flat uses zero slope. Fixed retains
explicit slopes for hand editing. These implement documented DCC concepts, not
bit-for-bit Maya tangent algorithms. Weighted time coordinates are solved before
evaluating the cubic, so the displayed curve and scene use the same evaluator.

Rotation is XYZ Euler degrees. A 0→720 curve performs two turns, rather than
taking a quaternion shortest path. Gizmo commits choose the nearest equivalent
XYZ representation to the displayed pose; typed values retain intentional full
turns. **Animation → Rotation Curves** offers explicit cleanup for selected or
all animated objects/joints. **XYZ Euler filter** chooses the nearest equivalent
XYZ branch and requires matching key times on all three axes. **Channel unwrap**
supports independently keyed axes by adding multiples of 360 degrees. The first
key stays unchanged. Both can remove intentional spins and change motion between
keys; use Undo to restore the original curves. SDK curves are excluded. The panel
also applies explicit Bézier, Linear, or Stepped interpolation to scoped rotation
curves. Automatic tangents recompute; fixed tangents follow the chosen Euler branch.
Alternate rotation orders and quaternion-curve editing are not implemented.
Interpolation holds endpoint values outside keys;
pre/post-infinity cycle modes are not implemented.

Visibility channels use stepped playback and are authored through the Properties
visibility controls or SDK. The standard transform **S** command creates
position/rotation/scale tracks; the visibility checkbox/diamond handles visibility.

## Dope Sheet

The Dope Sheet lists object/joint channels as rows and shares key selection with
the Graph Editor. Shift-click or box-select keys across multiple objects, then
drag to retime them together. **Shift frames** and **Shift** apply a numeric
offset. **Time scale** and **Scale time** scale selected times around the earliest
selected key, snapping results to whole frames. Copy, paste, deletion, framing,
zooming, and history use the same commands as the Graph Editor.

The current sheet edits channel rows. It does not provide animation clips,
layer compositing, range ripple editing, or a nonlinear animation editor.

## Set Driven Key

1. Open **Animation → Set Driven Key**.
2. Choose the driver object and attribute, or select it in the scene and click
   **Load selected as driver**.
3. Choose the driven object and attribute. They may be different attributes on
   the same object.
4. Enter a **Driver value** and **Driven value**, then click **Set driven key**.
5. Enter another pair and set another key. Change the driver in Properties, or
   animate it with ordinary time keys, to see the response.

**Load current values** samples channels after SDK and before IK/constraints,
including unkeyed FK editing previews. Values typed into this panel are draft mapping values until
**Set driven key** is pressed; they do not directly move the objects.

The **Relationships** list exposes each mapping. Its response curve plots driver
value horizontally and driven value vertically. Edit either value, interpolation,
or tangent preset in the key table. **Load relationship** restores its property
selectors for adding another pair. Delete individual keys or remove a complete
relationship; removing the last key also removes that dependency.

One driver may control many outputs. An output has one driver, and may not also
have a time curve. Cycles are rejected at the property level, including indirect
cycles. Chained mappings evaluate in dependency order and hold endpoint values
outside the driver range. Visibility defaults to stepped response; interpolated
scale remains positive. These records and edits support project saving and undo.

Choose **Edit curve in Graph Editor**, or set the Graph Editor's **Graph source**
to **Driven keys**, to edit response curves with the shared key and tangent tools.
The horizontal axis is **Driver value**, with fractional coordinates and no frame
snapping. The **Driver cursor** chooses where Insert/Paste operates; it never
changes scene time or the actual driver. **Use scene driver** follows the active
relationship's pre-IK driver again. Curve selection, clipboard and view are
independent from time animation; the Dope Sheet continues to edit time keys only.
The selected-target filter includes either side of a relationship. SDK visibility
can use continuous interpolation, although rendered visibility switches at 0.5.

SDK uses the same curve representation/evaluator as time animation. IK blend is
time-keyed only: SDK accepts transform/joint
pose properties, not handle properties, as either driver or output.
Multiple-driver blending and driving from post-IK solved
values are not implemented; SDK evaluates before IK and constraints.

Open [examples/driven-curves-study.msb](../examples/driven-curves-study.msb) for
weighted lift, rotation, scale and continuous visibility mappings driven by a
time-animated controller. Regenerate with
`node scripts/create-driven-curves-example.mjs`. The generator checks 1,001 curve
samples and 385 scene-time samples before and after native archive readback.

## FK, IK, binding, and elasticity

### Build a joint controller with Set Driven Key

Open [examples/controller-sdk-rig.msb](../examples/controller-sdk-rig.msb) for an
original three-joint arm with a rational NURBS elbow control. Its Rotation X
drives Elbow Rotation Z; frames 0, 24 and 48 curl and return the arm. Regenerate
with `node scripts/create-controller-sdk-example.mjs`, which checks 193 fractional
frame samples before and after archive readback. The scene contains no external
assets, binding or IK handle.

1. Select a joint in **View > Outliner**, then use **Rigging > Create Circle
   Control**, **Create Square Control** or **Create Arrow Control**. The new root
   control matches the one selected object's or joint's evaluated world pose and
   becomes selected. With no selection it is created at the origin. For explicit
   name, plane and size settings, use **Rigging > Curve Controls**. Direct actions
   use those panel settings and automatically enable matching for one selection.
2. In **Curve Controls**, click **Use as Set Driven Key driver**. This opens
   **Animation > Set Driven Key**, loads the control and focuses its Driver
   attribute. Choose **rotation.x**. Choose the joint as Driven object and
   **rotation.z** as its attribute.
3. Enter Driver **0**, Driven **0**, then **Set driven key**. Enter Driver **90**,
   Driven **100**, and key again. These draft values author the mapping; the
   control's actual transform is edited in **View > Properties**.
4. Edit a response value in the relationship table, or choose **Edit curve in
   Graph Editor** for key/tangent editing. Response changes are ordinary undoable
   document edits. Each driven attribute supports one driver; cycles and time
   keys on the same output channel are rejected atomically.
5. Select the control, open **View > Properties**, enter Rotation X **0** at
   frame **0**, and click its **Key Rotation X** diamond. At frame **24**, enter
   **90** and key that channel again. Scrub frame **12**: with the 0→100 mapping
   the elbow rotates **50°**. **S** keys all supported selected channels; the
   channel diamond keys just the intended driver.
6. **File > Save scene**, then **Open scene** preserves the rational control,
   CV edits, SDK response and driver time keys. Reopen the appropriate dock using
   View, Rigging or Animation if a saved workspace places it behind another tab.

CV coordinates and rational weights preview directly in the viewport while
typing or middle-dragging. Enter/blur or drag release commits one undo step;
Escape restores the authored shape. Right-click a number for Lock/Unlock.
Preview geometry stays outside the scene/archive and history. CV selection is
numeric in the panel; viewport CV handles remain a separate capability.

This adapts Maya's [NURBS primitive creation](https://help.autodesk.com/cloudhelp/2025/ENU/Maya-Modeling/files/GUID-47BBC51D-CEBF-4233-B2DF-AF3E6A6AB8AA.htm)
and [Set Driven Key window](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-Animation/files/GUID-D2B1C7EF-F177-4B0E-9E41-B479CFF2AFD4.htm):
named curve primitives, driver/driven object and channel loading, and explicit
value-pair keying. Musubi groups rig controls under Rigging, keeps SDK under
Animation, and offers direct world-pose matching as a browser-friendly shortcut.
No shortcut is added and native field focus/text editing is preserved. The new
commands use text labels and original application UI; no Autodesk assets are
copied. Sampling reuses installed Three.js 0.180.0's MIT-licensed NURBSCurve;
there are no new dependencies, services or format changes.

The Rigging panel already supports joint creation, parenting, FK rotation,
binding, unbinding, and elasticity. Select a splat and Shift-select joints before
**Bind splats**. Automatic distance weights use up to four influences per splat.
The **Elasticity** tool applies to bound parent–child connections; its properties
control deformation and the bounded allocation of fill splats. These existing
systems consume the final animated joint pose.

In **Rigging → IK Handles**, select a **Root joint** and descendant **End joint**,
choose a **Solver**, then click **Create IK handle**. **Use selected joints** loads
a root/end pair from the scene. **CCD** is the default and supports multi-joint
chains. **Analytic two-bone** requires exactly three joints: root, middle, and
end. Creation is disabled for a different chain length. The selected handle's
**Solver** can also be changed afterward; an invalid two-bone chain is rejected.
Older files without a solver setting continue to use CCD.

The target is a world-space XYZ position. Change it to solve the chain; both
solvers use the FK/IK blend to retain FK at zero or apply the solution at one.
Without control links, **Match target to FK** places the target at the current FK endpoint. For an
analytic handle it also derives the pole from that FK pose, preserving the
current bend direction when defined. This matching command does not key joints
or change the blend. Enable/disable, literal targets/poles, control links, solver choice, blend, CCD
iteration count, and handle removal are document edits with undo and serialization.

Analytic handles expose **World-space pole target** with **Pole X**, **Pole Y**,
and **Pole Z** fields. The pole determines the bend plane and which side the
middle joint bends toward. Initial creation or a switch from CCD derives a pole
from the current FK pose unless that handle already has one. Edit the coordinates
numerically, or click **Select pole target** and move its viewport marker with
the translation gizmo. Pole markers are also directly selectable. As with target
drags, release commits one edit and **Escape** cancels the drag. Numeric fields
commit on Enter or blur, and Escape cancels the pending field edit. CCD hides the
pole controls; analytic mode hides **Solver iterations**, which it does not use.

### Animate targets and poles with controls

Choose an ordinary transform in **Target control** or **Pole control**, or click
**Create target control** / **Create pole control** to create and link an editable
circle / arrow curve at the current point. Creation and linking form one undo
step. **Keep target position when linking** preserves the point using a world-space
offset; clearing it snaps the point to the chosen control's world origin. Choose
**None · static target** to unlink while retaining the currently evaluated point.
Pole controls are available for analytic two-bone handles.

Use **Move target control** or **Move pole control**, or click its target/pole
marker, to select the linked scene object. Move it with the ordinary viewport
gizmo: the chain updates during the drag. Use the same Animation-mode transform
key workflow as other objects, including **S**, the timeline, and the Graph Editor.
The control can also be driven by SDK or supported constraints. The panel's
linked XYZ fields show resolved world coordinates read-only; edit the control's
transform instead. Unlinked marker drags continue to edit static target points.

With links, the matching button becomes **Match controls to FK and key**. In
Animation mode it places the target at the prepared FK endpoint and the analytic
pole along the FK bend direction, then keys linked controls' local position XYZ
at the exact current frame. It preserves world offsets, converts through evaluated
parent transforms, and updates any unlinked target/pole point in the same undo
step. It does not change the blend or key the joints. Position channels owned by
SDK or an enabled Point/Parent constraint reject matching; remove the SDK
relationship or disable the competing constraint first. Incompatible requests
for one object used as both controls, noninvertible parents, or an unkeyed parent
preview that would shift the saved result also reject the entire command.
Matching also verifies every prepared FK chain joint's world position and
orientation. If control keys would move that chain through a downstream SDK
relationship, the whole edit is rejected; unrelated or constant SDK responses
that leave the chain unchanged remain supported.

Control links, offsets, curves, and keys save in `.msb` files. Deleting a linked
control through the editor unlinks it and freezes the current resolved point;
undo restores both object and link. A document-only deletion without an evaluated
pose uses the fallback point captured when the link was created or rebound.

Linked control and root-parent constraints run before IK when required to place
the solver's inputs. Their hierarchy and constraint-source dependencies form a
prerequisite closure. Remaining constraints run after IK, including chain-output
constraints that are not prerequisites. This plan includes every configured link
even when the handle is disabled, blend is zero, or a CCD handle retains a latent
pole link; toggling those settings does not reorder the rig. Hierarchy or
constraint dependencies that reach any IK chain are rejected, including
cross-chain feedback. SDK continues to read pre-IK authored/time/preview channels
and earlier SDK outputs. With no links, the original time → SDK → IK → constraints
order remains unchanged.

### Animate FK/IK blend

In **Rigging → IK Handles**, set **FK / IK blend** to 0 for FK or 1 for IK; values
between them blend the joint rotations. In Animation mode, **Key blend** keys the
current value at the current rounded frame. **Edit blend curve** opens and frames
the handle's existing curve in the Graph Editor; it is disabled until a curve
exists. A logically selected IK handle also supports **S** and timeline key
commands, without creating transform channels for the handle.

Before the first key, the blend field edits the static saved fallback. Once blend
keys exist, editing the field or slider explicitly sets a key at the current
rounded frame, even with auto-key off; the panel displays this behavior in its
help text. Slider movement previews the pose, release commits one undo step,
and **Escape** cancels the slider preview. Changed numeric values commit on Enter
or blur; inspecting an unchanged value does not insert a key. Blend edits at the
same frame preserve unkeyed controller and joint pose previews. Scrubbing to a
different frame still clears those previews.
Graph and Dope Sheet tools edit the same track. Deleting all its keys restores
the saved static fallback. Solver evaluation, markers, matching, and historical
particle sampling all use the blend at their requested frame. Disabling a handle
still bypasses IK regardless of its keyed blend.

Blend tracks and keys persist in `.msb` scenes. Deleting the handle or a chain
that removes it also removes its blend curves; undo restores them together.
Old files with only static blend continue to work. Blend cannot be driven by
Set Driven Key in this implementation.

### Capture IK as FK

To keep the current solved pose as FK, select an enabled handle with blend above
zero and click **Match FK to IK and key**. The command captures XYZ local rotation
keys for every joint from root through end at the current frame, then sets the
handle's blend to zero. If a blend track exists, this writes a zero key at the
captured frame; otherwise it changes the static fallback. Both changes form one
undo command. It samples the IK
result after prerequisite constraints and IK, but before remaining constraints,
and chooses equivalent Euler angles near the current FK values to preserve
rotation continuity. Existing keys at that frame retain
their interpolation and tangent settings; new keys use auto Bezier tangents.
Position and scale keys are unchanged.

Matching rejects chains with SDK-owned rotation channels or enabled Orient,
Aim, or Parent constraints on their joints. Disable or remove those competing
rotation controls before matching. A disabled handle or zero blend has no active
IK pose to capture. This command matches one frame; it neither bakes a frame
range nor guarantees a seamless switch elsewhere. Without a blend curve, its
static fallback change still affects every frame. With a curve, inspect nearby
blend keys and tangents to control the transition around the captured frame.

Before committing, matching checks that the chain keeps its world positions and
orientations, both before and after constraints. Unkeyed position previews or
rotation-driven dependencies can make a rotation-only match change the pose;
the command then rejects the entire edit. Key those position previews or resolve
the dependencies first. Point constraints are allowed when the resulting pose
remains unchanged.

For an unlinked target, click **Move target in viewport** to select its marker and attach
the translation gizmo. Target markers can also be selected by clicking them in
the viewport. Drag to preview the solution; release records one target edit in
history. **Escape** cancels the drag, and **Delete** removes the selected handle.
The marker is a viewport control for the handle's stored world-space target,
not a separate scene transform node or animation channel.

CCD reuses Three.js `CCDIKSolver`; unreachable targets produce a bounded iterative
approximation. The analytic two-bone solver preserves both bone lengths and
places unreachable targets at the nearest reachable distance, without stretching.
Pole directions that coincide with the root or align with the root-to-target
direction use a deterministic fallback. Straight or folded chains and crossing
these singular directions can still flip the bend plane; the solver does not
track bend continuity across frames. Position the pole clearly beside the target
line to choose an unambiguous bend. Chains may not overlap or control ancestors
of another chain, preventing order-dependent results.

Solver choice and literal target/pole points remain static saved settings. Linked
target and pole transforms and the handle's blend use animation curves. Both solvers share
the current-frame **Match FK to IK and key** workflow above. Angular limits,
stretch, and SDK-driven blend
remain unavailable. Matching a target position alone does not reproduce every
possible elbow/knee bend. There is no animation layer
for blending competing rigs. Use the FK and animation controls for authored poses.

## Joint orientation and local axes

**Rigging → Joint Settings** exposes static **Joint orientation** XYZ degrees,
separate from keyed rotation channels. Local rotation composes orientation first,
then channel rotation. FK, CCD, analytic IK, constraints and reparenting share the
same conversion helpers. Legacy files default to zero orientation.

**Show local axes** displays the evaluated joint frame and saves per joint.
**Freeze FK rotations into orientation** absorbs the prepared FK rotations and
zeroes channels while preserving the current local and descendant world poses.
It uses the descendant scope and rebases stored preferred angles. Rotation time
curves, rotation SDK dependencies, active rotation constraints and affecting IK
must first be removed, baked or disabled; the command rejects incompatible cases
atomically. Existing captured skin rest matrices are retained. Manual orientation
edits intentionally change the pose. Automatic orient-to-child is not yet provided.

## Joint and pose mirroring

Open **Rigging → Mirror Joints / Pose**. Choose a source subtree, an X/Y/Z world
origin plane and literal name substitution (for example `L_` to `R_`).
**Mirror joint subtree** creates a detached mirrored root with remapped descendants,
orientation and preferred angles. It mirrors authored joint frames, leaving time
animation, controls, constraints, IK handles and skin bindings on the source.

For existing named counterparts, **Mirror FK pose** reflects current prepared FK
onto the paired joints; **Mirror FK pose and key** keys their position/rotation
through the active layer. Name ambiguity, ownership conflicts and inconsistent
composed results reject atomically. The operation reflects world frames using
`R * M * R`, preserving proper handedness. It is not Maya's equal-channel Behavior
mode. Source/destination parents may differ; target-local channels compensate.
The command verifies final world poses before one undoable commit.

## Preferred joint angles

Open **Rigging → Joint Settings** and choose a joint, or use the current viewport
selection. **Capture FK angles** stores local XYZ rotations from the prepared FK
pose, before IK. With **Include descendants** enabled, capture applies to the
whole joint hierarchy beneath that joint. Pose a useful elbow/knee bend before
capturing; a straight preferred pose still needs the solver's singular fallback.

The XYZ fields edit the selected joint's stored preference. **Clear preferred
angles** restores FK-based solver initialization for the chosen scope. Both CCD
and analytic two-bone IK seed their solved links from stored preferences, while
partial IK blend still starts from the current animated or previewed FK pose.
The end joint keeps its FK local orientation. Preferences are static settings;
they do not change bone positions, joint orientation, rotation limits, or bind
matrices. Existing scenes without preferences keep their previous behavior.

**Key preferred FK angles** writes rotation X/Y/Z at the current frame for the
selected scope, in one undo step. Every joint in scope must have preferences, and
normal SDK/channel ownership rules apply. Keying leaves IK enabled; use blend 0
to view the keyed FK pose. Capture, manual editing, clearing, and keying all
support undo and saving. Metadata-only preference edits retain unkeyed FK input
previews; scrubbing, keying, and changes to other rig inputs still invalidate them.

The [preferred-pose study](../examples/preferred-ik-motion.msb) captures shoulder
and elbow angles at frame 0 in the animated-blend example. Without preferences,
the inferred hinge reverses when the FK elbow crosses zero near frames 50.6521
and 70.8977. With preferences, the same solver starts on a consistent branch.
`node scripts/create-preferred-ik-example.mjs` verifies those crossings, target
reach, historical evaluation, archive readback, and the resulting half-frame bake.
The maximum measured quarter-frame bake endpoint error drops from 1.63 to
0.000655 scene units. Pole/target singularities and shortest-arc quaternion blend
discontinuities can still occur in other poses; this feature is not a universal
continuity solver.

This follows Maya's [preferred-angle workflow](https://help.autodesk.com/cloudhelp/2025/ENU/Maya-CharacterAnimation/files/GUID-5A8BB621-96E0-4CE8-9792-085EC8F07164.htm),
adapted to the existing Three.js and ozz-based solvers without new solver math.

## Bake IK to FK

Open **Animation → Bake IK to FK**, or **Bake frame range…** in IK Handles.
Choose a handle, start/end frames, and a positive sample interval. **Use playback
range** copies the current timeline bounds. Both endpoints are sampled, including
an end frame that falls between interval steps. Fractional frames are supported.

**Bake IK to FK** evaluates the saved time curves, driven relationships, linked
controls, constraints, and IK blend. It replaces the chain's rotation X/Y/Z curves
inside the range with linear keys, then disables that handle for the whole scene.
The control objects, target/pole links, and blend curves remain available. Unkeyed
viewport previews are excluded. **View joint curves** selects the root joint and
opens its rotation curves in the Graph Editor.

**Keep keys outside range** retains those key records exactly; turning it off
removes outside keys on the baked rotation channels. Other channels are unchanged.
Disabling IK globally and changing adjacent curve interpolation can change motion
outside the chosen range. **Minimize rotation** chooses equivalent Euler angles
near the previous sample to reduce jumps. Sample more densely for rapid spins:
rotation minimization cannot reconstruct intentional turns between sparse samples.

Before committing, the command evaluates the candidate and original scenes at
every sample, checking all object/joint world matrices and visibility. Conflicting
driven rotation channels, rotation constraints, downstream changes caused by
SDK feedback, or an evaluation failure reject the whole bake. Cancellation and
concurrent document changes also leave the candidate uncommitted. Sampling and
verification yield periodically to keep cancellation responsive. A successful bake
is one undo step, including the handle's enabled state.

The limit is 10,001 samples, 100,000 resulting time keys, and 2,000,000 estimated
scene-node samples per operation. Linear Euler interpolation approximates motion
between samples; use smaller intervals when subframe motion matters, including
historical particle paths. This tool bakes one chain's rotations. Multi-chain
baking, adaptive key reduction, arbitrary constraint baking, and animation-layer
baking remain future work.

The [baked example](../examples/baked-ik-motion.msb) samples the animated blend
study every half frame. Run `node scripts/create-ik-bake-example.mjs` to regenerate
it and verify sampled poses, between-sample error, undo/redo, historical evaluation,
and archive readback.

The example's mixed-blend source already changes pose abruptly near frames 51
and 71. Its half-frame bake matches sampled matrices within 1.3e-15, but the
largest measured quarter-frame endpoint difference is 1.63 scene units around
those changes. A denser sample interval narrows the affected intervals; it does
not repair a discontinuity in the source rig. The preferred-angle workflow above
removes these particular FK zero-crossing discontinuities before baking.

## Skin weights

The [skin-weight study](../examples/skin-weights-study.msb) is reproducible with
`node scripts/create-skin-weights-example.mjs`. It has three bound joints,
11,629 original components, and Tip weight 0.85 on indices 0–511. Middle rotates
over frames 0–48, making the edited region easy to inspect while scrubbing.

Open **Rigging → Skin Weights** and choose a **Bound splat object**, or select
one in the Outliner. In **Selection mode → Range**, enter the inclusive **First component index** and **Last
component index**. **Previous component** and **Next component** replace the
range with one adjacent component. Choose a **Joint influence**, enter its
**Weight · 0 to 1**, and click **Apply influence weight**. The inspection table
shows the first component's effective influences, total, and whether its weights
are automatic or authored. **Reset selected to automatic** clears overrides in
the range; **Reset all overrides** clears the entire shape's overrides.

For direct selection, enable **Select components in viewport**. A click selects
the nearest projected original component center within eight CSS pixels; drag a
rectangle to select centers through the object. **Shift** adds and **Ctrl**
(or **Cmd**) subtracts. This switches to **Viewport selection** mode, whose
read-only **Selected component indices** list shows the exact sorted selection.
It can contain separate groups of indices: applying or resetting weights affects
only those indices, never the intervening range. A nonempty result automatically
shows the weight preview. An empty click leaves picking active so another click
can select a component.

Selections are limited to 20,000 components. An oversized box or addition keeps
the previous selection unchanged. **Clear component selection** stops picking
and leaves an empty Viewport selection; editing is disabled until components
are selected or Range mode is chosen. Committing range fields or using Previous/
Next explicitly returns to Range mode. **Escape** cancels an in-progress scan
and stops picking; the completed selection remains. Playback also stops picking
while retaining the selection. Changing the bound object, unbinding, or opening
a scene clears it. Component selection is temporary editor state, with no undo
entry or saved archive data; weight edits still use normal undo and persistence.

Picking scans original component centers in bounded chunks. Changes to the scene
or view cancel an unfinished scan, so it cannot apply a selection from stale
positions. This is X-ray center selection, without occlusion tests or
splat-footprint intersection. For brush edits, use the separate Paint Skin Weights
panel below. Hidden objects and components below the
opacity picking threshold are excluded.

Weight editing applies to original components of an already bound splat object.
Component indices start at zero and stay tied to the loaded source asset.
Choose a bound influence and set its weight from zero to one for the selected
components. Other active influences scale proportionally to keep the total at
one. Setting an influence to zero removes it; setting it to one makes it the sole
influence. Add a second influence before reducing a sole influence, and remove
an existing influence before adding a fifth. Each component supports at most
four active bound joints.

Edits store sparse overrides with undo/redo. Unedited components keep the
existing nearest-four distance weighting; resetting selected components or all
overrides restores that automatic result. One command edits at most 20,000
components, and a shape stores at most 200,000 overrides. Reopening a scene
checks the original component count against the source before using saved
weights.

The editor retains precise authored weights, while Spark renders its existing
8-bit packed weights. Component previews use those packed values and current
joint transforms, so they follow the displayed deformation. Preview evaluation
reads only selected components and follows the same opacity filtering as object
picking. Elasticity fill inherits the edited weights, but generated fill splats
are excluded from component indices and cannot be edited individually.

**Show weights in viewport** draws points through the scene, from blue at zero
to orange at one for the chosen influence. At most 5,000 evenly sampled indices
are displayed from the active range or selected index set; edits still affect
every selected index. Preview hides during playback or manipulation and with
Gizmos hidden. Reset, unbind, and scene-object selection changes clear the preview. Preview settings create
no scene history entries.

Neither weight editor supports smoothing, influence locks, mirrored transfer,
or adding/removing joints from an existing binding. Bind and
unbind remain available through the existing rigging controls.
The workflow follows Autodesk's [numeric skin-weight editing](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-CharacterAnimation/files/GUID-1E9D36A8-92D1-4D1A-A769-D4A05AE852FB.htm)
and [interactive normalization](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Basics/files/GUID-F632811C-DE7C-4464-B025-9B6379FAA750.htm)
concepts, with normalization always enabled in this subset.
The rectangle-selection workflow follows Autodesk's [component marquee selection](https://help.autodesk.com/cloudhelp/2024/ENU/Maya-Basics/files/GUID-ABB00438-68A6-4108-8D79-C362F690E808.htm),
adapted here to original splat centers rather than polygon vertices, edges, or faces.

### Add and remove bound influences

The **Skin Weights → Bound joint influences** section adds joints at zero weight
using their current shape-local bind matrix. Remove redistributes surviving
weights proportionally. If a component uses only the removed influence, choose
an explicit replacement or the command rejects without changes. The last bound
influence cannot be removed; use Unbind instead.

Palette edits materialize every current effective row, preserving existing
automatic and authored weights. This supports loaded assets up to 200,000 source
components and retains the four-active-influence limit. Larger assets reject
atomically. Resetting to automatic later intentionally recomputes against the
edited influence palette. Each palette edit is one undo step and saves in `.msb`.

## Paint Skin Weights

Open **Rigging → Paint Skin Weights**. Choose a **Bound splat object** and a
bound **Joint influence**, then set **Mode**, **Value · 0 to 1**,
**Strength · 0 to 1**, and **Radius · CSS pixels**. Radius ranges from 1 to 256
screen pixels and stays the same screen size as the camera zooms. Defaults are
Replace, Value 1, Strength 0.5, and Radius 32. Numeric fields commit on **Enter**
or blur; **Escape** cancels an uncommitted field edit.

Enable **Paint weights in viewport**, then drag with the left mouse button.
The circular cursor shows the brush radius. Painting affects projected original
component centers through the object, including centers behind visible surfaces;
it does not test surface occlusion or the full splat footprint. Generated elastic
fill is excluded. Painting and the Skin Weights component-selection tool are
mutually exclusive; the component selection does not act as a paint mask.

| Mode | Result |
| --- | --- |
| Replace | Moves the starting weight toward Value, scaled by Strength and falloff |
| Add | Adds Value × Strength × falloff to the starting weight, clamped to 1 |
| Subtract | Subtracts Value × Strength × falloff from the starting weight, clamped to 0 |

Falloff is smooth from full strength at the center to zero at the edge:
`1 − smoothstep(0, 1, distance / radius)`. Each component uses the maximum
coverage reached anywhere along that stroke. Repeated passes within one stroke
do not accumulate; separate strokes do. Other influences retain their relative
proportions while the weights normalize to one. The same four-influence and
sole-influence rules as numeric editing apply.

Colored points preview the selected influence from blue at zero to orange at one.
The display samples at most 5,000 centers; this display cap does not restrict the
edit. During a stroke the colors change, while the geometry keeps its starting
deformation. Release the mouse to apply the weights and update deformation in
one undo step. A stroke may affect at most 20,000 original components; exceeding
that cap or encountering invalid normalization rejects the whole stroke. A
stroke that makes no changes creates no history entry. Committed weights use
the same sparse overrides and `.msb` persistence as numeric edits.

**Escape** during a stroke discards it and leaves painting enabled for another
stroke. **Escape** while idle exits painting. Hold **Alt** to orbit; Alt navigation,
mouse-wheel navigation, or another camera/view change cancels an unfinished
stroke. Scene or pose changes also invalidate unfinished work. Starting playback
stops painting. Changing the bound object or unbinding it clears the active
brush. Brush settings and previews are temporary editor state.

This brush has no smoothing, influence locks, mirrored painting/transfer,
occlusion-aware mode, stylus-pressure response, or live deformation during a
stroke. It is adapted from Autodesk's [Paint Skin Weights workflow](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-CharacterAnimation/files/GUID-99189E9D-237F-471E-A02C-BE6593B4828B.htm),
which provides influence selection, paint operations, brush value, and opacity.
Musubi exposes Strength and an explicit Subtract operation, with a fixed smooth
falloff and maximum coverage per stroke; it does not reproduce Maya's full
Artisan brush system.

## Curve controllers

Open **Rigging → Curve Controls** to create or edit a controller. Choose a preset,
plane and size, then click **Create curve control**. **Match selected world pose**
places it at one selected object's or joint's evaluated world transform; it does
not parent or constrain it. Unrepresentable shear and very small world scales are
rejected with an explanation.

Curve controllers are selectable line shapes attached to ordinary scene
transforms. Use a Circle, Square, or Arrow preset, choose its XY, XZ, or YZ plane,
and set its size and color. The default plane is XZ. The Circle uses rational
quadratic NURBS data; Square and Arrow use straight segments. Transform and
animate the controller through the same Properties, timeline, and Graph Editor
as other objects. Connect its channels through SDK or use its transform as a
constraint source to drive a joint or object. Creating a controller alone does
not connect it to a rig.

Shape editing changes local control vertices (CVs), including positive rational
weights. Degree 1, 2, and 3 curves are supported. Rebuilding knots changes the
curve while retaining its CVs and weights; it is not a shape-preserving degree
conversion. Closing a curve adds an endpoint connection, without creating a
periodic spline. Shape edits use undo/redo and save inside the `.msb` document;
they require no external asset files.

The [controller study](../examples/controller-study.msb) contains a splat, an
edited circle controller, and an arrow control. The circle's Position X keys
move 4→6 over frames 0→24, and a point constraint makes the splat follow it.
The first circle CV has X=3; the arrow was placed at the circle's frame-12 pose.

These are rig controls, not a NURBS surface modeling system. There is no CV
animation, construction history, curve-to-surface modeling, or periodic-curve
editing. Controllers contain no splats and cannot be bound or given elasticity.
Their display is a sampled line, and shape sampling is reused during playback.
CV editing is currently numeric in the Curve Controls panel; viewport CV
selection and manipulation are not implemented.

## Constraints

Open **Rigging → Constraints**. Choose **Source · follow this**, **Driven ·
constrain this**, and a constraint **Type**. The selection-loading buttons fill
the source/driven selectors from scene selection. Leave **Maintain offset**
checked to retain the current relationship, or clear it to align the affected
attributes, then click the corresponding **Create … constraint** button.

| Type | Result |
| --- | --- |
| Point | Follows world position; a maintained positional offset stays in world space |
| Orient | Follows world rotation using a stored quaternion offset |
| Aim | Rotates a selected local axis toward the source's world position, using a selected world-up direction |
| Scale | Follows world size with an optional multiplicative scale offset; object targets only |
| Parent | Follows position and rotation; target scale remains its underlying value |

Parent positional offsets are expressed relative to the source. Rotating or
scaling the source therefore also rotates or scales the offset's translation,
even though the constraint does not copy scale onto the driven object. Point
constraints instead add their positional offset in world space. The evaluation
converts world results back into the driven object's parent space.

The **Scene constraints** list provides Enabled and Delete controls. Disabling
a constraint removes its pose override; it does not bake the
constrained pose into keys. Creation, enable/disable, and deletion support undo
and archive persistence. Recreate a relationship to change its source, type, or
captured offset.

For **Aim**, choose **Look-at source · aim toward this** and **Driven · rotate
this**, then select a signed **Local aim axis** and **World up axis** from ±X,
±Y, or ±Z. Click **Create aim constraint**. Defaults are local **+Z** and world
**+Y**. The local up axis
is +Y, except that aiming ±Y uses local +Z as up. Clear **Maintain offset** for
the selected axis to point directly toward the source. When offset is maintained,
the initial world orientation is preserved relative to the initial aim solution;
the chosen axis therefore need not point directly at the source.

Aim changes rotation only. Its source and driven object must occupy distinct
world positions (separation greater than 0.00000001 scene units). Coincident
points are rejected; if animation reaches them, playback stops with an explanation
and the entire rig stage falls back to its input time/preview/SDK pose. When the aim
direction is parallel to world up, Three.js supplies a deterministic fallback
basis. This avoids undefined orientation but can produce a roll change near the
pole; it is not a continuity-preserving roll solver. There is no object-up mode,
animated up object, or multi-source aim weighting. Recreate the constraint to
change its captured offset or axis settings.

Constraints needed by linked IK inputs evaluate after time/preview/SDK and before
IK; the rest evaluate after IK, overriding their assigned channel groups. The
remaining constraints do not feed back into IK, and SDK is not reevaluated. Each
position, rotation, or scale group has one constraint source; Parent owns both
position and rotation, and Aim owns rotation. Cycles involving constraints and the hierarchy are
rejected, including disabled constraints, so enabling a record cannot introduce
a hidden cycle.

This subset has no multi-source weighting or constraint animation. Joint scale
constraints are disabled. Orient, Aim, Parent, and Scale reject nonuniformly
scaled driven-parent transforms. Orient, Parent and Scale also reject sheared
sources. Aim uses only the source position, so source shear is allowed. Point
supports arbitrary finite, invertible parent transforms. Non-finite values and
singular driven-parent transforms are rejected.

If animation reaches an unsupported constraint pose, playback stops and a notice
identifies the limitation. Prerequisite constraints, IK, and remaining constraints
evaluate atomically: failure restores the input time/preview/SDK pose, with no
partial prerequisite or IK results retained.
Disabled constraints remain editable, so the offending relationship can be
disabled or deleted before repairing the hierarchy or animation.

## Performance and verification

Development CPU measurements were approximately **0.56 ms for 1,000 animation
tracks**, **2.62 ms for 20 IK chains**, and **0.44 ms for 100 parent constraints**
on the local development machine. The constraint measurement used 100 Node CPU
evaluations taking 43.5 ms in total.
These are narrow CPU microbenchmarks, not end-to-end frame times. They exclude
WebGL/Spark rendering, skinning/binding uploads, elasticity, UI rendering,
source-asset loading, and device/browser variation. Large weighted curves and
large splat scenes still require representative profiling.

The linked-control benchmark (`node scripts/benchmark-ik-controls.mjs`) used
Node 22.16, 50 warmups, and 300 measured samples. Full time → SDK → prerequisite
constraints → IK → remaining-constraints evaluation measured **0.0448 ms median /
0.0944 ms p95 for one chain**, and **0.2472 ms median / 0.4230 ms p95 for 16 chains**.
For 16 chains, historical sampling on uncached frames measured **0.281 ms median /
0.651 ms p95**; primed cache hits were about **0.0001 ms**. These CPU-only timings
exclude browser scheduling, rendering, skinning, and editor callbacks, and are
not an end-to-end playback frame-rate claim.

The animated-blend run (`node scripts/benchmark-ik-blend.mjs`) used the same
Node 22.16, 50-warmup/300-sample setup. Full stages measured **0.04625 ms median /
0.1226 ms p95 for one chain** and **0.28335 ms median / 0.4566 ms p95 for 16 chains**.
Historical sampling for 16 chains measured **0.30215 ms median / 0.6643 ms p95**
on cache misses and about **0.0001 ms median / 0.0002 ms p95** on primed hits.
The same CPU-only exclusions apply; this measures neither browser playback nor
rendering, skinning, overlays, or editor callbacks.

Run `npm test` for focused model, command, archive, and regression tests. Run
`npm run build` for TypeScript checking and the production bundle. No separate
lint script is configured. Tests cover weighted curves, full-turn rotations,
key edits/history, SDK cycles/order, animated FK edit continuity, IK solving,
and existing scene/elasticity behavior. The example scene supports repeatable
manual browser checks; it does not substitute for imported production assets.
See [VALIDATION.md](VALIDATION.md) for the dated verification record and measured
small-scene playback results.

## Remaining work, in priority order

1. Automatic joint orientation, rotation limits, stretch, SDK-driven blend,
   and multi-chain/adaptive IK/FK baking.
2. Aim object-up/roll controls, multi-source constraint weighting, constraint
   animation, and richer controller/component editing.
3. Weight smoothing/locks, mirrored weight transfer and conventional deformers.
4. Layer flattening, camera/custom-property animation, richer
   clipboard/retargeting.
5. Additional polygon tools, materials/UVs, mesh skinning, and mesh import/export;
   see the [modeling guide](MODELING.md) for the implemented subset.
6. Particle collisions, trails, animated emitter properties, and cache export;
   see the [particle guide](PARTICLES.md) for the implemented subset.

## References and licenses

Functional references are Autodesk's [Graph Editor tangents documentation](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Animation/files/GUID-43A4FE2C-4863-4EA6-B6AE-6D2B6757F6C7.htm)
and [Set Driven Key workflow](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-Animation/files/GUID-F5429279-8EDB-449C-9E8D-4B5C0210757D.htm).
The aim workflow follows Autodesk's [Aim constraint options](https://help.autodesk.com/cloudhelp/2024/ENU/Maya-CharacterAnimation/files/GUID-D4769D95-EC0E-4C94-AF60-8EB3FC4305E4.htm):
the local aim direction points toward a target, and a world-up direction controls
roll. Musubi uses +Z as its default aim axis, while Maya documents +X, and exposes
only signed-axis vector-up settings rather than Maya's full set of up modes.
Autodesk's [IK/FK Keys menu](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-Animation/files/GUID-C5ACDDBC-9E30-443C-8419-F07FC41E9A86.htm)
distinguishes moving an IK target to an FK endpoint from keying the handle and
joint chain. Its [IK/FK blending workflow](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-CharacterAnimation/files/GUID-8B0B343A-B00A-427C-8C79-E2B9008C4A88.htm)
also animates blend values across frames. Musubi supports time-keyed blend,
target alignment with linked-control position keys, and current-frame rotation
capture and sampled range baking. The bake workflow follows Autodesk's
[Bake Simulation options](https://help.autodesk.com/cloudhelp/2024/ENU/Maya-Animation/files/GUID-A11424B4-8384-4832-B18D-01264E1A19D1.htm)
and [`bakeResults`](https://help.autodesk.com/cloudhelp/2025/ENU/Maya-Tech-Docs/Commands/bakeResults.html):
sample intervals, outside-key retention, rotation minimization, and disabling
implicit IK control. Musubi implements a focused one-chain subset of these tools.
Curve terminology follows Autodesk's [NURBS curve components](https://help.autodesk.com/cloudhelp/ENU/MayaCRE-Modeling/files/GUID-3C709643-E723-4518-84B7-45EB07778AD2.htm)
and [curve degree overview](https://help.autodesk.com/cloudhelp/2023/ENU/Maya-Modeling/files/GUID-0C6DD36E-E336-4DE2-ADA1-86665998EF77.htm).
Musubi supports degrees 1–3 and stores the full Three.js knot vector; it does not
import Maya curve files or implement Maya's complete curve editing toolset.
The interface adapts these concepts without using Autodesk code, branding,
proprietary artwork, or file formats.

Curve primitives, NURBS sampling, line rendering, and CCD solving reuse the existing Three.js dependency. Its
[MIT license](https://github.com/mrdoob/three.js/blob/r180/LICENSE) is compatible
with this Apache-2.0 project. Analytic two-bone solving adapts Guillaume Blanc's
MIT-licensed [ozz-animation `IKTwoBoneJob`](https://github.com/guillaumeblanc/ozz-animation/blob/744eb9d99f606eda849acb0b1204f7a3dc20bca1/src/animation/runtime/ik_two_bone_job.cc),
pinned to commit `744eb9d99f606eda849acb0b1204f7a3dc20bca1`. The port uses full
reach (soften = 1), zero twist, and deterministic fallback adaptations at singular
configurations. Its copyright and MIT notice are retained in
[public/licenses/ozz-animation.txt](../public/licenses/ozz-animation.txt), included
in the built distribution. No new package dependencies or paid services were
introduced for these animation/rigging additions. Other dependencies retain
their existing licenses.


### Edit layer weight keys

In **Animation > Animation Layers**, expand **Weight curve keys** for the active
layer. Select a key in the native list, then edit its exact fractional **Frame**,
0-1 **Value**, or outgoing **Interpolation** (Step, Linear, Bezier). Moving a key
past its neighbors keeps that key selected and preserves its identity and tangent
metadata. Conflicting key times and invalid values are rejected atomically.
**Remove selected weight key** removes the selected key at its exact time; removing
the last key restores the unchanged fallback weight.

Tab and native list arrow keys navigate these controls. Enter commits a numeric
edit; Escape restores the saved value. Middle-drag previews the numeric field and
commits one undoable edit on release; Escape or pointer cancellation restores the
field. Right-click either numeric field for Lock/Unlock. A locked animation layer
allows viewing the list and prevents all curve edits. Undo/redo and current MSB
save/reopen preserve the complete curve. Weight keys remain independent of the
pose Graph Editor and Dope Sheet.


Expand **Tangents** within the selected weight key to choose Auto, Clamped, Flat,
Spline or Fixed. These controls use Bezier interpolation. Fixed freezes the
current effective slopes. **Broken** lets in/out slopes change independently;
**Linked** aligns slopes to the current in slope and future slope edits move both
sides together. Handle weights remain independent in either state.

In/out slopes use weight units per frame. Handle weights range from 0 to 1 of
the adjoining segment duration (default one-third). Editing either numeric
handle switches the key to Fixed; other keys and the opposite broken handle
retain their metadata. These fields support the same Enter, Escape, middle-drag
and per-key Lock/Unlock interactions as Frame and Value. Preset changes retain
stored handle metadata, so switching back to Fixed freezes the currently sampled
preset slopes. No document changes occur during numeric drag drafts.
