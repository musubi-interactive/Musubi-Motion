# Particle Burst Baker

Open **Particle Burst Baker** from the Musubi Tools launcher, or visit `/tools/particle-burst/` on the editor's server. The page includes a burst to try immediately.

1. Set the emitter in **Emission**, motion in **Dynamics**, and start/end appearance in **Shading**. A cone half-angle of 180° emits in every direction. Azimuth turns from +X toward +Z. Elevation measures up from the XZ plane. Positive gravity accelerates downward.
2. Play or choose a frame at 24 fps. Drag to orbit, right-drag to pan, scroll to zoom, or use **Frame Burst** to fit the visible particles. Middle-drag a numeric value to preview it and release to commit one edit. Escape cancels the active edit. Undo and Redo apply to recipe changes, including opening another recipe.
3. Click **Bake Frame to PLY** and import the file into the Musubi editor to edit it as a splat object. **Save Recipe** and **Open Recipe** keep the editable burst setup in local JSON files.

The evaluator samples each particle directly at the requested time from its fixed birth time and seeded launch velocity. Births are evenly spaced across the emission duration. With duration zero they start simultaneously. Each particle has the same lifetime. Size, peak opacity, and the numerical sRGB channels interpolate linearly over age. The PLY stores world-space positions. The editor applies its usual centering transform on import. Each exported Gaussian is isotropic with standard deviation equal to half the authored diameter. PLY writes 3DGS DC color coefficients, logit opacity, natural-log scales and WXYZ rotation.

The preview shows a transparent Gaussian point approximation out to three standard deviations. Large points can be limited by the graphics hardware, and compositing can differ from the editor's splat renderer. The baked file stores a single static sample. Export skips invisible particles and is unavailable on an empty frame. The authoring range is 12,000 particles, 10 seconds of emission and 20 seconds of lifetime, with JSON recipes capped at 4 KiB. Recipes are separate from MSB projects.
