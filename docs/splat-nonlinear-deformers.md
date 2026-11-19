# Nonlinear splat deformers

Use `examples/splat-deformer-tower.splat` to inspect the three operations on the same source. The tower has 272 anisotropic splats and an offset gold seam that makes twist direction visible. Regenerate it with `node scripts/generate-splat-deformer-fixture.mjs`. The fixture and implementation are original and require no additional assets or dependencies.

The handles use local Y as the deformation axis. The center handle translates, rotates, or scales the frame. The two bound handles move along that frame's Y axis. The low bound ranges from −10 to 0 and the high bound from 0 to 10 in handle units. New frames fit the selected bounds and use a uniform scale of half the longest extent. The panel uses degrees for rotation, curvature, and angle entry. The frame's transforms and bounds can be keyed individually. These conventions follow Maya's nonlinear deformer controls and fit Musubi's existing viewport transform and numeric field workflow. [Bend attributes](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-CharacterAnimation/files/GUID-8B61889D-3B83-4557-9675-F3088255E101.htm), [Bend manipulators](https://help.autodesk.com/cloudhelp/2025/ENU/Maya-CharacterAnimation/files/GUID-AAEFF09F-B950-405F-BD97-4D25D0E1CAA4.htm), [Twist attributes](https://help.autodesk.com/cloudhelp/ENU/MayaCRE-CharacterAnimation/files/GUID-544B501F-AA8C-4F4E-89F4-9951244C8C0D.htm), [Squash attributes](https://help.autodesk.com/cloudhelp/ENU/MayaCRE-CharacterAnimation/files/GUID-57F6F201-6DCB-4D88-8267-A4A282C587C5.htm).

## Evaluation

Each evaluator returns a deformed center and its analytical Jacobian. The stack transports covariance as `J Σ Jᵀ`. A frame with linear part `A` conjugates the local Jacobian as `A J A⁻¹`. Membership, mask and envelope multiply the amount before evaluating the map. For example, a 180° twist under a 50% influence rotates by 90° and preserves the cross section. Zero influence, neutral parameters and bound spans below 0.001 handle units retain the input center and identity Jacobian exactly.

### Bend

Curvature sets the angle in degrees per handle unit. The local Y coordinate is clamped between the bounds for the arc angle `θ = k clamp(y)`. Outside the bounds, the map follows the endpoint tangent. In the classical cylindrical region, the local center is `(x cos θ + (1 − cos θ)/k, (1/k − x) sin θ, z)`. A centered expression for the cosine difference and the ratio `sin θ / θ` keep the formula stable near zero curvature.

The classical axial scale `q = 1 − kx` reaches zero at the bend axis. For `kx > 1/2`, Musubi extends it with `q = 1/4 + (1/4)/(1+4(kx−1/2))` and uses `(1−q)/k` in place of `x`. The resulting radial derivative is positive and matches the classical derivative at the transition. The Jacobian's X and Y columns follow the rotated radial and tangent directions, respectively. The radial derivative multiplies the X column. The Y column is scaled by `q` inside the bounds and by 1 in the tangent extensions.

### Twist

Twist rotates X and Z about local Y. The angle interpolates linearly from Start Angle at Low Bound to End Angle at High Bound and stays constant in each tail. The derivative of the angle contributes shear in the Jacobian's Y column. Its determinant is 1 across the interval and in the tails.

### Squash and Stretch

Factor controls axial compression or extension. The peak axial scale is `s = 2^(factor × influence)`. The bulge profile `B` is a pair of cubic smoothsteps from 0 at the bounds to 1 at Max Expand Position. Its integral determines the axial displacement, anchored at the frame origin. Outside the bounds, the radial scale is 1 and the axial offset is constant.

With Preserve Volume off, axial scale is `a = 1 + (s−1)B` and radial scale is `r = s^(−Expand × B/2)`. Preserve Volume broadens the axial profile by adding `(Expand/(1+Expand)) B(1−B)` to it and sets `r = 1/√a`. Expand then changes the breadth of the bulge. The Jacobian's diagonal contains `(r,a,r)`, and its Y column includes the derivative of the radial scale times the incoming X and Z. The determinant `r²a` is exactly 1 with Preserve Volume on. The allowed factor range [−3, 3] keeps the axial scale positive in both modes.

Bend and Twist use the interior derivative exactly at a bound. Their centers are continuous through the bound and the tangent or shear switches on the outer side. Squash has zero slope in the blend profile at both bounds.
