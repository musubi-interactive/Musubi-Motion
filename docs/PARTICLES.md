# Particle FX guide

Choose the **FX** workspace or open **FX → Particle Emitters** to create and configure
point-based particle effects. Emitter transforms use the same Properties panel,
object gizmos, timeline animation, Set Driven Key, and constraints as other scene
objects. Particle settings themselves are static document properties.

## Create an emitter

In **Create emitter**, choose a Type, enter a Name, and click **Create particle
emitter**. Omni, Directional, Box volume, and Sphere volume emitters start at the
origin. Position and animate their transforms with the regular object tools.
Select an emitter in the Outliner or the panel's **Emitter** menu to edit it.

| Type | Birth position and initial direction |
| --- | --- |
| Omni | Emitter origin, with directions distributed over the full sphere |
| Directional | Emitter origin, using Local direction and Spread |
| Box volume | Within the local box extents, using Local direction and Spread |
| Sphere volume | Within the local ellipsoid defined by the XYZ extents, using Local direction and Spread |
| Mesh surface | Sampled points on a polygon mesh, using the sampled face normal and Spread |

For **Mesh surface**, first select exactly one polygon mesh in the Outliner.
Creation is disabled with an explanation when no mesh is selected. The new
emitter is parented beneath the mesh transform, initially with an identity local
transform. Its source reference is saved and cannot be retargeted; create another
surface emitter to choose a different source. The source must remain a polygon
mesh, and the emitter must remain beneath its source transform.

Surface sampling is weighted by transformed triangle area, including nonuniform
scale. Births use the source and emitter transforms evaluated at their historical
birth times. Moving an emitter affects new particles; previously born particles
continue in world space instead of following the object. Velocity magnitude uses
world units per second and does not scale with the emitter transform.

The creation types and terminology follow Autodesk's [Create Emitter and Emit
From Object options](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-SimulationEffects/files/GUID-8782D1CA-A428-4E8A-B6DF-39190CE692AD.htm),
adapted to the supported point, volume, and polygon-surface subset. This is not
Maya Nucleus or a complete implementation of Maya's emitter options.

## Emission

**Enabled** controls whether the emitter participates in the effect. **Rate** is
particles per second and **Lifetime** is seconds per particle. Expand **Timing
and random seed** to edit the start frame, end frame, and unsigned integer seed.
Emission starts at the start frame and stops before the end frame. Existing
particles continue until their lifetime expires. Frame timing uses the scene FPS.

Expand **Emission direction and spread** for Directional and volume emitters.
**Local direction** must be a nonzero XYZ vector. **Spread** ranges from 0 for
the direction axis to 1 for the full sphere. Surface emitters use the sampled
mesh normal instead of a direction vector and expose the same spread control.
Omni emitters already cover every direction, so these controls are hidden.

**Emission volume** appears for Box volume and Sphere volume. Its three values
are full local XYZ extents, not radii. Values must be positive and at most 10,000.
Emitter transforms determine the volume's placement, orientation, and scale.

## Dynamics

**Initial speed** sets the mean launch speed. **Speed variation · units/second**
sets the total random range centered on that speed:
`max(0, speed + (random − 0.5) × variation)`. For example, Speed 2 and variation 1
produce initial speeds from 1.5 to 2.5. This setting is an absolute range, not a
fraction or percentage.

Secondary settings are grouped in expandable sections:

- **Acceleration and drag** supplies a constant world-space XYZ acceleration
  and drag per second. The default acceleration is `[0, -3, 0]`.
- **Turbulence** supplies strength and spatial scale. Strength zero disables its
  contribution; scale must remain positive.
- **Attraction / repulsion** supplies a world-space position, strength, and
  radius. Positive strength attracts, negative strength repels, and zero disables
  the field. Radius must remain positive.

These fields belong to the emitter configuration. They are not independent
Outliner objects, and their properties do not yet have animation channels.

## Appearance

Start and end **diameter** are world-space sizes, not radii or screen pixels.
Start/end colors and opacities vary over each particle's lifetime. Expand
**Opacity over lifetime** to edit transparency. Zero size or opacity is allowed.

The current renderer displays point particles. It does not generate Gaussian
splats, mesh instances, trails, ribbons, or volumetric smoke. The emitter remains
a scene object with its own transform; individual particles are simulation
results, not selectable scene objects.

## Editing, replay, and saving

Numeric settings commit on **Enter** or blur; **Escape** discards a pending field
edit. Creation and each committed settings edit use shared validated commands,
with undo/redo. Controls disable during playback or other busy editing operations.
Changing settings can require a replay, shown by the panel's particle count and
**Replaying simulation…** status. Runtime errors appear there as well.

Simulation uses canonical completed steps of **1/120 second**. Births are grouped
at step starts, and rendering a fractional time does not introduce a different
partial integration step. Forward evaluation advances the fixed-step state;
scrubbing backward or invalidating the scene replays from the seeded start.
For unchanged settings, transforms, and evaluation inputs, this produces the same
result independent of the path used to reach that frame. It does not promise
bit-identical floating-point results across all browsers and hardware.

Transform animation is evaluated at simulation times, so a moving emitter leaves
a world-space stream of particles. Scrubbing far forward can require substantial
replay work; pending status is not a completed simulation result. Refreshing the
panel reads status only and does not restart the simulation.

### Prewarm a replay range

Select an emitter in **FX → Particle Emitters** and enter inclusive whole
**Start frame** and **End frame** values under **Replay Cache**. Both frames
must be in the current playback range. Choose **Prewarm particle replay** and
watch the progress below the button. Use **Cancel prewarm**, or press
**Escape** while focus is in **Replay Cache**. The two fields and the button
are reachable by **Tab**, and **Enter** or **Space** activates the button.
Seeking, changing the scene or selection, and closing the emitter or scene
also cancel in-progress work. The playhead and visible cloud stay in place
during prewarm, and the operation makes no undo entry.

The action follows Maya's selected-object cache workflow and inclusive start and
end frames. [Create an nParticle nCache](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-SimulationEffects/files/GUID-7FB6513C-28FF-4B68-A77C-8AF86B51F0DC.htm),
[nCache Start/End options](https://help.autodesk.com/cloudhelp/2025/ENU/Maya-SimulationEffects/files/GUID-C24C3A7E-B63A-4061-9E3D-59D89297C19A.htm).

Musubi stores checkpoints at the first and last simulated steps in the range
and at the regular one-second boundaries within it. A seek replays the last
few fixed steps from the nearest usable checkpoint. The simulation starts
from the newest available checkpoint at or before the range start, or from
the emitter's authored starting state. The cache belongs to the current
document revision and stays in memory.

Each request permits at most 1,800 fixed steps (15 simulation seconds),
including replay before the requested start, and up to 30 million estimated
live-particle steps. A job can stage at most 16 MiB of checkpoint buffers
while also referencing its starting checkpoint. The cooperative 20-second
wall-clock limit is checked between batches. An individual synchronous step
or browser image decode can delay cancellation until control returns.
Completed checkpoints enter the same shared 32 MiB, 128-entry FIFO as
ordinary replay checkpoints. Canceling or timing out discards the staged
checkpoints. For a long replay, cache consecutive sections while checkpoints
from earlier sections are still available.

`.msb` scenes save emitter settings, source references, transform animation, and
the seed. They do not save a baked particle cache or the currently live particle
buffers. Opening a scene regenerates its effect through the same evaluation path.
See [VALIDATION.md](VALIDATION.md) for the separate verification record.

## Limits

Open [examples/particle-study.msb](../examples/particle-study.msb) for a moving
fountain, mesh-surface mist, volume rain, and mixed mesh/curve/splat objects.
Rebuild it with `node scripts/create-particle-example.mjs`.

Particles render as soft circular shader points. Their maximum screen size is
limited by the device's point-size range. Opaque meshes occlude them, but sorting
between transparent objects, individual particles, and Gaussian splats is
approximate. Select an emitter using its octahedral viewport marker or Outliner;
framing includes its current cloud. Pending replay keeps the last completed cloud visible.

Validation rejects an entire edit if it exceeds a limit or makes the emitter
invalid. Current bounds include:

- 32 emitters per scene; 20,000 potential live particles per emitter and 100,000
  total across the scene. The estimate uses rate and lifetime with a small step
  margin, so setting `rate × lifetime` exactly at a cap may still be rejected.
- Rate 0–10,000 per second; lifetime 0.01–60 seconds; speed and speed variation
  0–10,000 world units per second.
- Integer start/end frames within ±100,000, end after start, and an emission
  duration of at most 300 seconds at the scene FPS.
- Seed 0–4,294,967,295; spread and opacity 0–1; world diameters 0–10,000.

There is no particle collision system, self-collision, mesh skinning, fluid
solver, trail renderer, Gaussian-splat particle rendering, particle cache export,
or per-particle editing. Emitter-property animation, additional volume types,
curve emission, and independent animated field objects remain future work.

## Dependencies and licenses

Particle integration uses the pinned **three-nebula 13.3.0** package, distributed
under its [MIT license](../public/licenses/three-nebula.txt), included in the built
distribution. Rendering keeps
the existing **Three.js 0.180** dependency under its
[MIT license](https://github.com/mrdoob/three.js/blob/r180/LICENSE). Three.js was
not upgraded for this slice. The editor remains Apache-2.0; Autodesk documentation
is a functional reference, with no Autodesk code or artwork included.

Nebula's published bundle includes utility code; retained notices for
[Lodash](../public/licenses/nebula-lodash.txt),
[potpack](../public/licenses/nebula-potpack.txt), and
[uuid](../public/licenses/nebula-uuid.txt) also ship in production builds.
