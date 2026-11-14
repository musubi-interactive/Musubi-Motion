# Mesh image textures

Select one polygon mesh in the viewport or Outliner and open **View → Materials**. Choose its **Material slot**, then **Base Color**, **Opacity**, **Normal**, or **Roughness**. Choose an image from the library or use **Texture Assets…** to import a PNG, JPEG, or WebP. **None** clears that channel. The library retains the original image, and other materials keep their own assignments. FBX material names, group ordering, existing maps, and UV seams are preserved.

Use **Texture Mapping** to select an existing UV set, set U/V repeat, offset and rotation pivot, rotate in degrees, and set wrap and filtering. Repeat and Mirror tile outside 0–1. Clamp extends the edge pixels. Nearest keeps hard texel edges, Linear blends neighboring texels, and Mipmapped also filters distant surfaces in the viewport. **Flip image vertically** changes the uploaded row order.

Type or middle-drag a numeric value to preview it. Enter, blur, or releasing the drag commits one undoable edit. Escape restores the original value and viewport. The numeric context menu locks a field for this session.

Base Color defaults to sRGB for Color images and Raw for Data images. Change its interpretation independently of the library role. Opacity and Roughness use the green channel, and normal maps use tangent-space RGB. These three channels use Raw. A newly assigned base image with alpha or an Opacity map enables blending where needed. Existing FBX alpha cutouts keep their cutoff. Fully opaque maps can write depth in the opaque pass.

Assigning an image to a bare single planar face, such as a Plane from **Modeling → Mesh Tools → Create Primitive**, creates UV 0 in the same undoable edit. Meshes with multiple faces use their existing UVs. A missing UV set or asset is reported before a command changes the scene. Clear or replace an assignment to remove the reference.

Native MSB archives store shared image references and sampler settings. Mesh-to-splat conversion uses the authored base-color and opacity settings, with level-zero sampling for Mipmapped filtering because surface samples have no screen-space derivatives. Unpremultiplied WebGL2 readback preserves channel data even when the source image alpha is zero. Normal and roughness detail remain mesh shading. Conversion supports up to 16 million pixels per image, 32 million distinct decoded texture pixels per mesh, and the GPU's texture dimension limit.

## Examples

Open [the textured plane](../examples/textures/mesh-materials.msb) and select **Texture Plane**. Change Repeat U or Rotate UV, then cancel or undo the edit. Import [the two-slot FBX](../examples/textures/material-seams.fbx) into the same scene. Assign the checker image to its two material slots separately to inspect the diagonal UV seam. Regenerate the MSB with `node scripts/create-mesh-material-example.mjs`. Both scenes and the checker are original project fixtures.

The dock follows Maya's File texture assignment and place2dTexture placement controls. The existing View menu opens Musubi's docked material controls, and image selection reuses its Texture Assets library. This uses the installed Three.js 0.180.0 sampler and Spark 2.4.0 conversion path. [Maya texture mapping](https://help.autodesk.com/cloudhelp/2024/ENU/Maya-LightingShading/files/GUID-3B5E91EA-446C-4B93-8E22-FCDD08EE86AC.htm) · [Maya texture placement](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Tech-Docs/Nodes/place2dTexture.html)
