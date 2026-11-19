# Courier character study

Open [character-remix.msb](../examples/character-remix.msb). The orange-helmeted courier is an original 7,600-splat conversion. Its hidden **Source character** mesh carries the same six-joint rig, materials and facial expressions. The project includes all its assets.

1. Select **Courier** and scrub from frame 0 to 24. The left elbow bends, the wrist crosses the jacket, and the head turns while the courier smiles and blinks. Frame 48 returns to rest. In Properties, change Smile at frame 24 while the head is turned. Blink has its own curve. Undo restores the pose.
2. Use **Deform → Splat Deformers** and select **Visor correction**. Edit its lattice, inspect the point channels in the animation editors, and undo a correction. This lattice acts after the facial targets and before the skeleton. The jacket material uses a separate scalar mask and procedural appearance layer.
3. At the crossed-wrist frame, try a small component selection on the wrist with **Scene visible** and then **Through**. Use the Skin Weights dock to compare rest-space smoothing and mirrored transfer previews, keeping a chosen influence locked. Scrub again after applying an edit and verify that undo returns the original pose.
4. To repeat the conversion, select **Source character** in the Outliner and use **Modeling → Convert to splats**. Choose a sample count and convert. Hide Courier so the new object can be viewed alone. The new object shares the skeleton and has independent Smile and Blink weights and time curves. Save the project and reopen it offline at a fractional frame.

## How converted blend shapes work

A converted shape stores only the mesh vertices and triangles that supplied visible samples, their sparse morph displacements and references from original splat IDs to triangles. Alpha-cutout candidates consume no IDs. Each frame combines the active target weights at the original mesh vertices. Each triangle then supplies one affine map for its samples, including the surface normal, so the ellipsoids turn and stretch with the face. Exact collapses, such as a shut eyelid, use a small in-plane thickness to keep the Gaussian invertible.

The order is facial morphs, authored component transforms, ordered splat deformers, then skinning. Picking and drawing consume the same transform. The conversion supports up to 100,000 samples per part, 128 named blend shapes and one million nonzero vertex-target entries. Four bone weights per splat approximate triangles with mixed skin influences. A converted object is independent of later edits to the source geometry. A live surface binding for an existing captured scan is a separate workflow.

To edit control points together, Shift-click points or enter their numbers in the deformer panel. A lattice also offers rows along an axis and planes normal to an axis. Rebinding with identical bounds preserves compatible offsets and animation exactly. When the new grid cannot represent the motion, the editor keeps the existing bind. Choose **Reset point edits and keys** only when starting a fresh bind.

The Graph Editor and Dope Sheet test splat deformer and facial curve edits against the loaded geometry before adding an undo step. They check the displayed pose plus a sample of edited key times, neighboring keys and Bézier extrema. Larger stacks use fewer sample frames to keep editing responsive. Playback validates the composed geometry at each evaluated frame.

Regenerate the study with `node scripts/create-character-remix.mjs`.

The playback benchmark runs with `node scripts/benchmark-splat-deformers.mjs`. It measures CPU evaluation and packing on 80,000 originals animated through bend, twist and squash. Browser navigation and rendering add latency beyond this measurement.
