# Custom attributes and curve SDK controls

Select an object in the Outliner, then choose **Edit > Add Attribute…**. Enter a name, default and optional minimum/maximum. Choose Float, Boolean or Enum; Keyable is on by default. See [typed attributes](CUSTOM-ATTRIBUTE-TYPES.md) for discrete choices and stable enum editing. The Properties panel's **Extra Attributes** section works for NURBS controls, splats, polygon meshes, particle emitters, groups/transforms, joints and IK handles. There are currently no selectable camera/light scene nodes (the editor camera is viewport state).

Shape selection resolves to its parent transform. All shapes and the transform therefore show the same object attributes; joints and IK handles own attributes directly. Empty transforms represent groups and remain selectable in the Outliner. Group world transforms affect children normally. This feature does not add group creation or reparenting commands.

Type a value or middle-drag its value/label (0.1 per 10 pixels). Both preview immediately, including driven joints. Escape cancels exactly; Enter or release commits one undo step. A value outside its limits is rejected with feedback. A lock icon or right-click **Lock/Unlock** changes the saved attribute lock; locking blocks value, definition, key and SDK curve edits while existing animation continues evaluating. Unlock before editing or deleting a locked attribute.

Click the diamond to key that attribute at the current frame. Right-click its diamond to open its curve in the Graph Editor; Graph labels include the name and Float type. Standard Set Key also includes unlocked keyable custom attributes. Changing an animated value creates a current-frame draft until keyed; moving time or starting playback discards that draft. Explicit value edits change the authored current value, while animation evaluation never mutates it. Transform Auto Key does not author unrelated custom channels. Layered custom channels use the same layer stack and inverse keying rules as transform channels; effective outputs clamp to attribute limits.

For a curl control:

1. Create/select a NURBS control and add `curl`, default/minimum 0, maximum 10.
2. Open **Animation > Set Driven Key**, load the control as Driver and select `curl`.
3. Load a joint as Driven and select a rotation channel. Key (curl 0, rotation 0), then (curl 10, rotation 90). Repeat for other joints.
4. In Properties, key curl 0 at frame 0 and curl 10 at frame 24. At frame 12 the linear example gives curl 5 and rotation 45 degrees.
5. Save an MSB. Definitions, stable references, time curves and driven curves reopen without network assets.

The original [example](../examples/custom-attributes-sdk.msb) contains a rational NURBS circle, three finger joints, one curl time curve and three SDK relationships. Regenerate it with `node scripts/create-custom-attributes-example.mjs`. It contains no downloaded models or textures.

Use the attribute's **…** button to rename or edit its definition. Names and object names are labels; references use stable object and attribute IDs. Changing limits or disabling Keyable on a referenced attribute requires removing its references first. **Delete Attribute** rejects connected attributes; **Delete Attribute and References** explicitly removes all its time curves and incoming/outgoing SDK relationships in one undo step. Object deletion similarly removes owned definitions and connected references. Deleting a shape alone preserves its transform's attributes. The existing **Mirror joint subtree** duplication copies authored definitions/current values with new attribute IDs and deliberately leaves animation/SDK on the source, matching that command's existing duplication policy. There is no general object duplication command in this build.

## Format and limits

Current `musubi-scene` v2 adds optional `customAttributes: Record<ownerId, CustomAttribute[]>`. A definition contains `{id,name,default,value,min?,max?,keyable,locked}`. Curve references use `custom.<id>`; evaluated poses carry fresh `customValues` maps. No authored arrays/maps are mutated during evaluation. Time curves are evaluated before SDK, then existing IK/constraints/skin stages continue. Locked definitions can retain existing stored animation. Non-keyable attributes can serve as SDK drivers but cannot receive time keys.

Validation accepts at most 64 attributes per owner and 10,000 total. Names are 1–80 ASCII letters/digits/underscores, start with a letter/underscore, and are unique case-insensitively per owner; builtin channel names are reserved. Stable IDs follow existing ID limits (1–100 ASCII letters/digits/underscore/hyphen, excluding prototype keys). Numeric values/limits are finite and within ±1e12, with minimum ≤ default/current ≤ maximum. Existing time/key limits still apply (100,000 keys; SDK input axis within ±1e6). Effective Bezier/layer overshoot clamps to limits. Invalid imported definitions or dangling custom time/SDK channels reject the complete open before editor state is replaced. MSB scene/archive versions remain 2/1; no compatibility reader or migration was added.

## Design and provenance

Official Autodesk [Maya 2025 custom attribute workflow](https://help.autodesk.com/cloudhelp/2025/ENU/Maya-Basics/files/GUID-EC37B453-05D8-4A60-B6A9-57895363759E.htm) and [Set Driven Key workflow](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-Animation/files/GUID-F5429279-8EDB-449C-9E8D-4B5C0210757D.htm) informed selection, name/default/limits, Keyable, Extra Attributes and driver/driven organization. The owner explicitly requested the **Edit** menu; Maya's documented main-menu equivalent is Modify. Boolean and Enum controls extend this workflow; their categorical layer behavior and permanent codes are documented in CUSTOM-ATTRIBUTE-TYPES.md. Native HTML modal focus/Enter/Escape adapts the browser; established Musubi MMB scrubbing and one-undo interaction remain. Existing Lucide lock/unlock SVGs communicate the saved lock operation; no Autodesk artwork/code was copied.

Implementation and procedural fixture are original, built on the existing animation/layer/Graph/SDK/archive modules. Existing Three.js 0.180.0, Spark 2.4.0 and Lucide installations are reused; no new dependencies, provider, model, network asset, license obligation or renderer was introduced. A separate GUI/animation dependency was unnecessary and would duplicate existing evaluation and persistence contracts. Verification covers a small original rig and generic object-kind drivers; it does not establish large-rig performance.
