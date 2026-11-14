# Duplicate selected splats

Select a splat object and enter **Select → Splat Components** (**F8**). Select the original splats to copy, then choose **Edit → Duplicate Selected Splats** or the matching button in **Splat Components → Component Edits**. The selection highlight remains visible while the copy is prepared. Press **Escape** or **Cancel duplication** to keep the current selection. On success, the new sibling object is selected in Object mode. It starts in the same place, so use the Outliner eye to view either object alone.

The duplicate has an independent splat asset, with dense IDs ordered by their original source IDs. It inherits the source's authored local transform, parent, pivot, shape offset and keyed pose and visibility channels. Skin uses the same joints and bind matrices with remapped per-splat overrides, so the shared rig still drives both bound objects. Component affine edits, paint, sets, masks, component locks and projected appearance remain editable on the copy. Every selected splat is copied at full strength, including splats reached by soft selection. Source geometry, edits and animation stay intact. One undo removes the new object and asset from the scene, and redo restores their IDs. Native `.msb` files include the copy and can reopen offline.

Duplication requires active originals, so show or restore hidden or deleted members first. The command requires a source without elasticity, incoming enabled constraints, or incoming driven pose channels. Elastic stretch and fill depend on the full source neighborhood. Keyed object and joint animation are supported. Object custom attributes and outgoing rig connections belong to the original object. Parent and joint animation are still shared.

The selection is limited to 100,000 records and, for skinned objects, 1,000,000 selected records multiplied by bound joints. The retained extraction asset budget is 64 MiB, estimated as four times the asset file size plus 1 MiB per copy for Spark texture padding and runtime buffers. Authored edit and scene limits also apply. A failed or canceled copy leaves the document and history intact.

## Native asset

A version-1 Musubi Extended Splats `.msext` asset lives inside the MSB archive. It stores the immediate source shape and asset IDs and original record count for provenance. It can reopen even if the parent source object was deleted. The little-endian file begins with `MES1`, then three uint32 values for selected count, source count and SH degree, and two uint16 byte lengths for the asset and shape IDs. The ASCII IDs are followed by padding to a 4-byte boundary. Each record stores its original uint32 ID, two packed Gaussian uint32×4 rows, and 0, 1, 2 or 4 SH uint32×4 rows for degrees 0 through 3. Packed Gaussian and SH words are copied from Spark's original extended data, preserving decoded attributes and directional color exactly. This is an internal project asset, loaded from the native project archive.

## Workflow reference

Maya's **Edit Mesh → Duplicate** with **Separate duplicated faces** provides the source-preserving component workflow. Musubi applies it to original splats with a single contextual action and no offset field or shortcut. Existing component selection, menu focus and object transform controls handle selection and placement. [Autodesk Maya Duplicate Faces Options](https://help.autodesk.com/cloudhelp/2024/ENU/Maya-Modeling/files/GUID-8A9AD59F-C12D-4F16-85F0-DA44392B4489.htm)

The copy codec and fixtures are original. The renderer and skinning path reuse the installed Spark 2.4.0 and Three.js 0.180.0 packages, both MIT licensed.
