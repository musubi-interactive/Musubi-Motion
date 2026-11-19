# Lattice and polygon cage

Open `examples/splat-cage-study.msb` and select **Cage Robot** in the Outliner. The second robot shares the source asset and provides a reference. The three pink splats beyond the arm help check the polygon cage boundary.

## Lattice

1. Open **Deform** and add **Lattice**. The lattice fits the original splat bounds with 2 × 5 × 2 control points.
2. Enable **Edit handles**. Click a control point in the viewport or choose its number in **Deformer handle**. Press **W** or use its X, Y and Z fields to move the point. Press **Escape** during a drag to restore the start position.
3. Use the diamond beside each coordinate to key it at the current frame. Each point has its own three channels.
4. Set **Center**, **Size** and **Divisions** under **Bind Geometry** and click **Rebind Lattice** to change the rest volume. Each axis supports 2–6 control points. Rebinding resets the point offsets and keys. Undo restores the prior bind geometry and animation.

## Polygon cage

1. Add **Polygon Cage**. It starts as a fitted box.
2. Choose **Robot Cage Driver** under **Cage mesh** and click **Rebind from Mesh**. The driver is a closed octahedron. **Open Driver** exercises the rejection path. Invalid input leaves the previous binding intact.
3. Enable **Edit handles** and move or key a cage vertex. The bound cage has its own point values. Edit the source in the mesh tools and rebind when you want to replace its geometry or topology.

A source cage can have up to 64 unique vertices and 124 triangles after triangulation. It must be a single, consistently wound closed surface, and every face must be visible from the cage's vertex centroid. The editor accepts convex cages and simple star-shaped cages that satisfy those conditions. Rebinding copies the mesh into splat-local coordinates and welds exact coincident corners.

## Evaluation

Both tools operate in the ordered splat deformer stack before skeletal deformation. The current upstream center is sampled against the immutable local rest volume. Centers outside a rest volume retain their upstream position and covariance. The selected original IDs, per-splat weights, mask and envelope remain properties of the deformer when rebinding. Local Jacobians are composed by the stack and used to transform the Gaussian covariance.

The regular lattice uses tensor-product Bernstein free-form deformation as described by Sederberg and Parry. The implementation evaluates weights and their analytic derivatives from the stored grid dimensions and the current input point. It stores no dense per-splat binding table. [Free-Form Deformation of Solid Geometric Models](https://people.eecs.berkeley.edu/~sequin/CS285/PAPERS/Sederberg_Parry.pdf)

For the polygon cage, we considered 3D mean value coordinates and a tetrahedral fan. Mean value coordinates offer smooth interior weights and work on more closed surface shapes. A tetrahedral fan provides affine precision, an analytic Jacobian, and bounded CPU work with the supported coarse cages. Each face forms a tetrahedron with the rest centroid. At that centroid the displacement is the average of the vertex displacements. The position field is continuous between cells. The Jacobian is piecewise constant and can change at a cell boundary. The cage code is an original implementation using the existing Three.js 0.180 math types. [Mean Value Coordinates for Closed Triangular Meshes](https://doi.org/10.1145/1073204.1073229)

The interface follows Maya's Deform placement, editable lattice points and wrap rest geometry. Musubi uses one point at a time, the existing Move gizmo and numeric field interactions, and a mesh picker in the deformer panel. The polygon rest shape is explicitly rebound from a scene mesh. [Maya Create Lattice Deformers](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-CharacterAnimation/files/GUID-8F27AC88-6892-4EAE-A1CB-C43FADF95A64.htm) · [Maya Lattice Options](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Animation/files/GUID-6EE9D875-5FEE-4631-81DE-772C2562B5A8.htm) · [Maya Editing Wrap Deformation Effects](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-CharacterAnimation/files/GUID-6222A8C7-DC36-4BF8-8747-5A1D29BAAE77.htm)

On a Ryzen 9 9900X with Node 22.16, 100,000 field samples took 128–143 ms for a 6 × 6 × 6 lattice with all 216 points moved, 10–14 ms for one moved lattice point, and 13–18 ms for a cage with 56 vertices and 108 triangles. The five timed runs included field preparation, centers and Jacobians. Browser rendering and GPU uploads are additional work. Sparse point edits and smaller lattices have lower evaluation costs.
