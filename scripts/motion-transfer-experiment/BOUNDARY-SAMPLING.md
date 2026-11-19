# Offline MT17 contact sampling convergence

Call `diagnoseStressContacts(rig, fixture, 'boundaryAware')` from the offline experiment to opt in. Omitting the mode retains the original prescribed 53 samples. The boundary-aware grid adds the authored stance endpoints and their ±0.000001-frame neighbors within frames 0–48. It removes duplicate timestamps. Every grid uses the existing gates of 0.02 target leg lengths for horizontal slip and 0.01 for penetration and absolute floor distance.

The comparison reuses the three TASK-012 stress variants, four target rigs, both explicit root policies and all three mapping paths. This yields 72 mapped clips and 264 foot stances per grid. The four gate decisions per stance include the combined result.

## Reproduced counterexamples

Both missed failures occur on the right foot of the fractional-boundary PROPORTION clip with the original mapper and the reference-relative XYZ root policy. Each boundary-aware maximum below also appeared at all three dense spacings.

| Stance frames | Metric | Sparse53 | Boundary-aware | Dense 0.125 / 0.0625 / 0.03125 |
| --- | --- | ---: | ---: | ---: |
| 0–24.375 | Maximum horizontal slip | 0.01566909148 (pass, 28 samples) | 0.02206536608 (fail, 34) | 0.02206536608 (fail, 196 / 391 / 781) |
| 47.625–48 | Maximum absolute floor distance | 0.00923569697 (pass, 2 samples) | 0.01027339418 (fail, 5) | 0.01027339418 (fail, 4 / 7 / 13) |

The boundary-aware grid changed 12 decisions from pass to fail across seven stance rows. All seven are from the fractional-boundary PROPORTION clip and its right foot.

| Root policy | Mapping path | Stance frames | Decisions changed to fail |
| --- | --- | --- | --- |
| Frame 0 to target reference | Original | 0–24.375 | Slip |
| Frame 0 to target reference | Aligned49 diagnostic | 0–24.375 | Slip |
| Reference-relative XYZ | Original | 0–24.375 | Slip, combined |
| Reference-relative XYZ | Original | 47.625–48 | Floor distance, combined |
| Reference-relative XYZ | Measured helper48 | 47.625–48 | Floor distance, combined |
| Reference-relative XYZ | Aligned49 diagnostic | 0–24.375 | Slip, combined |
| Reference-relative XYZ | Aligned49 diagnostic | 47.625–48 | Floor distance, combined |

## Convergence

The boundary-aware grid agreed with every dense grid on all 1,056 decisions. Both consecutive dense refinements also had zero disagreements. Counts below include each in-stance evaluation once per stance and mapped clip. The boundary-aware frame count is 61 for initial placement and shorter/faster swing, and 67 for fractional boundaries.

| Grid | Frames per clip | In-stance samples | Slip passes | Penetration passes | Floor distance passes | Combined passes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Sparse53 | 53 | 4,776 | 258 | 264 | 131 | 128 |
| Boundary-aware | 61 / 67 | 5,688 | 254 | 264 | 128 | 123 |
| Dense 0.125 | 385 | 32,808 | 254 | 264 | 128 | 123 |
| Dense 0.0625 | 769 | 65,352 | 254 | 264 | 128 | 123 |
| Dense 0.03125 | 1,537 | 130,440 | 254 | 264 | 128 | 123 |

The largest absolute gap for each metric across the 264 stances is given below in target leg lengths. Vertical max and RMS use absolute floor distance.

| Grids compared | Horizontal max | Horizontal RMS | Vertical max | Vertical RMS | Clearance max | Penetration max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Sparse53 vs boundary-aware | 0.00639630 | 0.00203263 | 0.00285263 | 0.000979783 | 0.00285263 | 0.0000151889 |
| Boundary-aware vs dense 0.125 | 0.0000486355 | 0.00162503 | 0.000138202 | 0.000743416 | 0 | 0.000138202 |
| Boundary-aware vs dense 0.0625 | 0.0000486355 | 0.00169229 | 0.000138202 | 0.000777416 | 0 | 0.000138202 |
| Boundary-aware vs dense 0.03125 | 0.0000486355 | 0.00172611 | 0.000138202 | 0.000794656 | 0 | 0.000138202 |
| Dense 0.125 vs 0.0625 | 0.000000173045 | 0.000127216 | 0 | 0.0000633820 | 0 | 0.00000132926 |
| Dense 0.0625 vs 0.03125 | 0.0000000201682 | 0.0000654344 | 0 | 0.0000326409 | 0 | 0.00000000921428 |

On the shorter/faster swing, the boundary-aware grid missed some interior peaks. The largest vertical max gap was in the right-foot stance from 42 to 48 on SCALE08, using the reference-relative XYZ policy and aligned49 path. It measured 0.0000338753 versus 0.000172078 on the finest grid. Closely spaced boundary samples also change the weighting of the sample RMS relative to a uniform grid. The dense refinements show smaller metric differences, but finite grids cannot bound unseen peaks between samples or establish continuous-time contact preservation. These measurements apply to the owned fixtures and their baked paths.

## Reproduce

Run from the repository root with dependencies installed. Setting the environment variable writes all 72 cases, per-stance measurements, directional disagreements, worst metric gaps and before/after fixture and helper hashes as JSON.

```powershell
$env:MT17_BOUNDARY_SAMPLING_EVIDENCE = './boundary-metrics.json'
npm test -- tests/motion-transfer-boundary-sampling.test.ts --exclude '**/.tmp/**' --no-cache --no-fsModuleCache --configLoader runner --maxWorkers 1 --no-file-parallelism
Remove-Item Env:MT17_BOUNDARY_SAMPLING_EVIDENCE
```

The TASK-012 report, metrics and two-file artifact (`sha256:686f6331d84ae7530aef854b905f7c247298dd45a40e7fb8fa31b126fab2f7b4`) were used as the baseline. The new run exactly reproduced every prior sparse53 and dense 0.125 contact row on Node 22.16.0. The test pins both baseline digests with numeric results rounded to nine decimal places for portability. In-memory source, reference, target and mapped snapshots and on-disk source/reference/helper hashes were checked for mutation. The sampler is original project code under Apache-2.0 and reuses the existing Three 0.180.0 helper under MIT.
