# Mixamo motion import

1. Download the matching rigged character from Mixamo and import its FBX through **File → Import…**. Select that same character in Mixamo, choose an animation, and download an FBX **Without Skin**.
2. Open **Animation → Import Motion Clip…**. Choose the animation FBX, a target rig, and a take. The Mixamo preset matches joints within the selected rig. It uses the name after the namespace separator and recognizes the flattened `mixamorig` names created by FBX import.
3. Review **Joint Mapping**. Each row shows the original source name and destination. Missing or duplicate names, different parents, and incompatible rest transforms appear next to the affected rows. To change an assignment, choose a **Source joint** and **Target joint**. **Apply Mixamo Preset** restores automatic assignments.
4. Scrub **Preview frame** to inspect the staged skeleton, including Hips translation. This scrubber leaves the main viewport, timeline and history intact. **Cancel** or **Escape** within the panel discards the staged file and preview.
5. Select **Import Clip** to create an editable override layer and seek to its first frame. Open the Graph Editor or Dope Sheet to edit its keys. Undo removes the layer and its keys together. Redo restores the same layer and key identities. Save as MSB to reopen the imported motion offline.

## Matching rig requirements

Use exports from the same character and coordinate conventions, with Y up and baked joint motion. Musubi uses the FBX loader's numeric coordinates as scene units. The preset checks one source skeleton, the expected humanoid parent roles, matching destination parents, and matching local rest offsets and orientations. Existing destination joints, skin bindings, and prior curve data stay in place. A joint's static orientation remains part of its local basis. The import keeps Hips translation and rotation and supports an equivalent named Root joint above Hips.

Required roles are Hips, Spine, Neck, Head, and each side's Arm, ForeArm, Hand, UpLeg, Leg, and Foot. Additional source joints such as Spine1, Spine2, shoulders, toes, and fingers need corresponding destinations with matching parents. A source joint maps to one distinct target. Keep the animated hierarchy in FK during import. Enabled incoming constraints or IK on mapped joints, driven translation or rotation channels, Solo layers, animated scaling, and animation targeting nonjoint objects stop the import with a diagnostic.

Source takes are sampled at the scene FPS into editable XYZ curves. The last FBX endpoint lands on the final sampled frame, rounded up to the next frame when necessary. Linear reduction preserves sampled values within 0.05 degrees and 0.0001 scene units. Between-frame interpolation follows the resulting Musubi curves. With an authored timeline, the new take starts at the first whole frame after the current end and existing keys. Stepped layer weight activates the take at its start and returns to zero one frame after the final key.

Motion FBX input is limited to 32 MiB, 256 source joints and 100 nonempty takes. Sampling is limited to two million channel values and 16 million key-reduction comparisons per take. The native scene limit of 100,000 authored keys still applies. Choose a shorter range or lower the scene FPS if an import reaches the budget.

## Original example

Import [matching-rig.fbx](../examples/motion/matching-rig.fbx) through **File → Import…**. In **Motion Import**, choose [motion-takes.fbx](../examples/motion/motion-takes.fbx). The **Arm Sweep** take rotates the left arm. **Root Travel** moves the same 22-joint skeleton through X and Z. The rig and animation have different namespaces. Regenerate both ASCII FBX files with `node scripts/create-mixamo-fixtures.mjs`.

The fixtures are original Apache-2.0 project assets. For your own project, use Mixamo's download flow and assets you have rights to use. [Adobe Mixamo animation downloads](https://helpx.adobe.com/creative-cloud/help/animate-characters-mixamo.html) · [Adobe character upload and rigging](https://helpx.adobe.com/creative-cloud/help/mixamo-rigging-animation.html) · [Adobe Mixamo usage FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)

The Animation menu and take picker follow Maya's Time Editor import workflow. The docked mapping table follows HumanIK's explicit joint assignment and naming template. Standard file picker and select keyboard behavior applies. The preview slider is a read-only timeline scrub, and import uses the existing scene edit and undo path. The implementation reuses the installed Three.js 0.180.0 FBXLoader and animation mixer (MIT). [Maya Time Editor FBX import](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Animation/files/GUID-B423CAD7-6198-421F-B4BF-EC0EB3B580E1.htm) · [Maya HumanIK Definition](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-CharacterAnimation/files/GUID-630B5349-213C-414D-B6C9-D283CE319472.htm)
