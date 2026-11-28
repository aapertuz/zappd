# Poppy Humanoid source import

The [Poppy hardware 1.0.2 release](https://github.com/poppy-project/poppy-humanoid/releases/tag/1.0.2) supplies a real `Poppy_Humanoid.STEP` assembly.
Its downloaded SHA-256 is `10e9d997f82787d4069f7edd4b88ec3ab6dcc51cb1686d761d84add709d38266`.

Hardware attribution belongs to the [Poppy project](https://www.poppy-project.org/) and its [authors](https://github.com/poppy-project/poppy-humanoid/blob/master/doc/authors.md).
The upstream [README](https://github.com/poppy-project/poppy-humanoid#license) licenses hardware under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
Preserve attribution and the share-alike license when redistributing derived CAD and render assets. Poppy is an upstream trademark.

## Current inspection catalog

Poppy is available as a partial source CAD inspection catalog. The complete pinned
1.0.2 occurrence hierarchy is retained. Each leaf is classified as available solid,
available surface, or unavailable geometry. The invalid `head_face` occurrence
remains rejected as CAD and is excluded from STEP. GLB/USDZ include its separately
pinned official per-part STL as an explicitly visual-only representation, described below.
A rigid rotation about X normalizes the source Y-up assembly to the existing CAD Z-up convention before centering and export.
The original official feet are used; no Onshape geometry is mixed into this source.
The local Onshape re-export has digest
`169dcbaaaa000dd142265ec80618903c5645b3b86bc8cfe348814501ded670ec` and was
investigated separately; its foot topology regression is not published.

The project and component provenance remain `unverified`.
All 201 available source CAD components pass the unchanged 0.1 mm CAD-to-render
trimmed-bounds comparison (recorded in `engineering.json`). The displayed meshes
remain inspection approximations; they do not establish manufacturing tolerances
or dimensionally certified production geometry. Successful topology and
mesh mapping checks establish inspection availability, not manufacturing validity.
Source-placement volumetric interference analysis is reported separately in
`interference.json`. The current report has 235 solids, 801 candidate pairs,
102 intersections between original source parts, and zero unresolved pairs.
All 206 candidate pairs involving an added PCB or cable have zero measured overlap.
Open surface bodies are excluded from volumetric checks.
The catalog has no mechanical assembly instructions. Deterministic
inspection explode offsets are computed from source component centers for
visualization; selection, camera controls, hierarchy navigation, part focus,
and inspection explode/reset work through the existing renderer.

Refresh the generated Poppy cache from the pinned sources:

```sh
backend/.venv/bin/python backend/cad_worker/refresh_poppy_cache.py
```

The command rebuilds COTS fixtures, imports the pinned Poppy STEP source, and exports the assembly. It verifies node coverage, the unverified validation status, artifact digests, and both public copies. The importer writes source metadata directly into `src/shared/domain/catalog/assemblies/poppy_humanoid_v1.json`, which both the TypeScript app and Python CAD worker load. Generated binary files follow the repository's ignored cache/export conventions.

Unresolved interference pairs are retried with a 180-second deadline. The command preserves the measured results and retry history in the cached report and public exports. Existing overlaps and rejected CAD remain explicitly unverified.

## Electronics and reference wiring

The inspection overlay adds connector datums to the pinned Odroid XU4, two
SMPS2Dynamixel injectors, lower Bioloid 3P hub, camera connector, Razor IMU,
and 25 Dynamixel motors. Motor names, IDs, and controller membership follow
the upstream configuration. [Poppy motor configuration](https://github.com/poppy-project/poppy-humanoid/blob/master/software/poppy_humanoid/configuration/poppy_humanoid.json)

Poppy has two isolated TTL buses. Each has a USB2AX, a 3P hub, and a 12 V injector.
The head computer and peripherals reflect the pinned 1.0.2 STEP.
[Bill of materials](https://github.com/poppy-project/poppy-docs/blob/master/en/assembly-guides/poppy-humanoid/bom.md),
[wiring guide](https://github.com/poppy-project/poppy-docs/blob/master/en/assembly-guides/poppy-humanoid/wiring_arrangement.md),
[archived XU4 head guide](https://github.com/poppy-project/Poppy-minimal-head-design/blob/odroid-xu4-integration/doc/head_back_xu4.md)

Two USB2AX reference boards and one upper 3P hub add the missing PCB geometry.
The USB2AX reference uses the repository's USB-C and JST-PH KiCad models.
KiCad checks the layouts and exports their colored STEP fixtures. The modeled
ports, branch order, and paths are inspection datums. Connector mating, pinouts,
cable lengths, and production PCB routing remain unverified.

The upper bus has 18 cable segments for the head, torso, and arms. The lower
bus has 13 for the pelvis and legs. Two additional cables link the head
computer to the camera and IMU. The USB2AX-to-hub leads carry data and ground.
Each injector supplies only its own bus. Cable endpoints come from the typed
ports in `poppy_humanoid_electronics.json`. The worker sweeps colored solid
conductors and preserves cable and board identities in STEP, GLB, and USDZ.

To regenerate the overlay and refresh the exact OpenCascade check:

```sh
backend/.venv/bin/python backend/cad_worker/poppy_electronics.py --verify-clear
```

The check rebuilds the candidate set from placed STEP fixtures and measures
every candidate involving an added PCB or cable. It can reuse prior
source-to-source results when both fixture digests and placements match.
The USB2AX boards clear the head shell and Odroid XU4 by at least 2.5 mm.
The upper hub clears the chest and its SMPS2Dynamixel by at least 2.5 mm.
The front shell remains visual only. Manufacturing readiness, materials,
tolerances, loads, and assembly constraints remain unverified.

## Import

Run the source adapter through the existing catalog ingestion command:

```sh
backend/.venv/bin/python backend/cad_worker/ingest_upstream_catalog.py --poppy
```

The importer rejects changed downloads and Git LFS pointers before OpenCascade reads them. It retains STEP product names, occurrence hierarchy, and composed source placements. IDs use occurrence paths within this pinned release, so repeated motor instances have different identities. IDs are not guaranteed across upstream releases.

Geometry uses the existing catalog centering and topology validation helper. Materials remain unspecified. Deterministic inspection explode offsets are computed from source component centers for visualization without implying an authoritative assembly sequence. No fastener relationships or build instructions are inferred from CAD product names.

A successful import writes the shared source-inspection catalog to `src/shared/domain/catalog/assemblies/poppy_humanoid_v1.json` and STEP fixtures to the existing cache. It does not classify the assembly as engineering-verified.

## Historical rejected full-assembly import

The pinned source fails the existing OpenCascade BRep topology check at occurrence `poppy_1_28_5`, the `head_face` product beneath the head assembly. The import stops without publishing a candidate catalog. Source geometry is not repaired, replaced, or fabricated to pass validation.

The import reached 188 cached part occurrences before this failure. These historical partial fixtures were not a validated assembly. The current partial inspection integration supplies GLB, USDZ, and a frontend catalog entry with unavailable geometry identified. It supplies no build instructions or engineering verification.

Registration as an engineering-verified catalog requires an authoritative source correction that preserves assembly identity and geometry and passes topology, interference, dimensional, and node mapping checks. Partial source inspection registration retains unavailable geometry and unverified provenance explicitly. A successful render alone does not establish mechanical safety or correctness.

## Source investigation, 2026-11-24

All three hardware release STEP assets were downloaded from the official repository and inspected with the installed OpenCascade STEPCAF reader. Every leaf definition was checked before applying occurrence placements. All three reject `head_face` at occurrence `1_28_5`, with `BRepCheck_UnorientableShape` on two subshapes. This is reproducible independently of centering, fixture export, and world transforms.

| Official release                                                                                                            | STEP SHA-256                                                       | Leaf occurrences | Invalid occurrences |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------- | ------------------- |
| [Official_1.0_Hardware_release](https://github.com/poppy-project/poppy-humanoid/releases/tag/Official_1.0_Hardware_release) | `52e08b4b01dc1ce4e5a9d417f947543c39dc7bb1a3bb85cc47e5913257ec91b3` | 201              | `head_face`         |
| [hardware_1.0.1](https://github.com/poppy-project/poppy-humanoid/releases/tag/hardware_1.0.1)                               | `84272b8ef46770c51bec9b0db8a8af53c0c6928d6a52db7cd2ea6023a93cb5f9` | 201              | `head_face`         |
| [1.0.2](https://github.com/poppy-project/poppy-humanoid/releases/tag/1.0.2)                                                 | `10e9d997f82787d4069f7edd4b88ec3ab6dcc51cb1686d761d84add709d38266` | 202              | `head_face`         |

The [release inventory](https://api.github.com/repos/poppy-project/poppy-humanoid/releases) has no other STEP asset. Releases 3.0.0 and 4.0.0-beta distribute operating-system images. The master tree at `d66c8fbd6aa3ebbf9e38399cc56aae3c155ee991` contains no STEP. The `dev_gen2` tree at `666d51cf1cc571964e629b7a066c69cb99774bb9` and `updated_hardware` tag at `823696c35d1ed3adf734ddc895b8b1f7d8aebbf1` contain a SolidWorks assembly and STL/URDF assets, but no corrected STEP export. An official-repository issue search for `STEP` returned no results.

The official 1.0.2 `solidworks-packngo.zip` was also downloaded and inspected. Its 72 entries include `head.SLDASM`, `head_face.sldprt`, `head_back.sldprt`, and `head_design.SLDPRT`, but no STEP. The hardware_1.0.1 Parasolid binary `Poppy_Humanoid.x_b` was downloaded as another authentic source. The installed OpenCascade pipeline does not read native SolidWorks or Parasolid binaries, and no SolidWorks-capable exporter is installed here. These remain possible upstream re-export paths, rather than sources that have passed validation. STL and URDF meshes cannot substitute for validated engineering CAD.

The importer now stages occurrence fixtures in a temporary directory. A topology rejection leaves the destination cache unchanged and removes the staged fixtures. Previously generated partial cache files are not retroactively validated or published. Tests exercise this late-failure behavior and nested rotation/translation with repeated occurrences through an actual STEPCAF export/import round trip.

The remaining `1.0rc4` tag (`b83ec0b9e34c42d2dcea7dff78ca3ff2820efb7b`) also has only a native SolidWorks assembly, without a STEP export.

An orientation-only normalization was tested on the unplaced 1.0.2 `head_face` definition. `ShapeFix_Shell.FixFaceOrientation` retained all 796 faces but returned false, and the shell remained invalid. The two rejected subshapes are faces 86 and 489. `ShapeFix_Face.FixOrientation` returned false for both; both faces and the reconstructed shape remained invalid. No normalization was applied to production source geometry. Broader healing, deleting faces, remeshing, or substituting another head would not establish geometry preservation.

Full-assembly engineering verification remains rejected. Partial source inspection registration and render assets are available with head_face excluded. Including that geometry requires a valid authoritative export or a demonstrated geometry-preserving correction. None of the checked exports meets that requirement in the installed importer.

Assembly coverage was checked independently on the 1.0.2 import. All 49 assembly definitions have a one-to-one match between their direct compound children and the placed shapes of their XCAF component references (`IsSame`, including locations). No unreferenced geometry owned directly by an assembly was found in this source. The importer continues to treat assembly nodes as hierarchy and leaf nodes as geometry; this check does not establish support for arbitrary mixed-geometry assemblies from other sources.

## Topology investigation beyond orientation

The repeatable diagnostic is `backend/cad_worker/diagnose_poppy_head.py`.
It verifies the original release digest, reads the unplaced `1_28_5` definition,
inspects the invalid faces and their edge parameterizations, and compares independent
copies after forced same-parameter repair, general shape healing, and sewing.
Run it with the pinned STEP path and an output JSON path. No repaired geometry is
published by this diagnostic.

Both faces 86 and 489 have cylindrical support surfaces and exactly zero axial
extent. Their UV bounds span one revolution in U and have identical V bounds,
`-4.29999999999999`. Each boundary consists of two nondegenerate semicircular
edges. Neither edge is a seam; both carry the same-parameter flag and edge tolerance
`1e-7 mm`. The original face area is exactly zero. This is a collapsed cylindrical
trim, rather than a shell placement or face direction problem. Flipping its wire
cannot introduce a second axial boundary. Expanding the trim would add surface
geometry; replacing the cylindrical support with a disk would change the source
surface. Deleting these faces is excluded by the requested repair constraints.

OCCT's [ShapeFix_Face reference](https://occt3d.com/dev/doc/refman/html/class_shape_fix___face.html)
explains that missing-seam repair handles separated closed wires on periodic
surfaces. These faces each have one wire, with no axial separation. The installed
OCCT is 7.8.1.1; its
[BRepCheck_Face implementation](https://github.com/Open-Cascade-SAS/OCCT/blob/V7_8_1/src/BRepCheck/BRepCheck_Face.cxx)
provides the orientation and wire classification checks used in the investigation.
The source-dependent regression can be run with `ZAPPD_POPPY_SOURCE=<STEP path>`
and `pytest backend/cad_worker/tests/test_poppy_topology.py`; it checks the actual
pinned source, including both collapsed trim intervals and zero areas.

Measured on the original head, the area is `42036.764425808164 mm²` and the
signed-volume integral is `40084.05972663066 mm³`. These integrals describe an
invalid BRep and do not establish its physical volume. General shape healing and
sewing retained all 796 faces, the same bounds, area, integral, and maximum edge
tolerance, but both results remained invalid. Forced same-parameter repair also
retained 796 faces and remained invalid; its area changed to
`42035.53649003103 mm²`, integral to `40116.15982863602 mm³`, and maximum edge
tolerance increased from `0.018265205479867694` to `0.019178273971137264 mm`.
It therefore supplies neither validity nor demonstrated preservation.

On both rejected faces, five samples per edge agree between the 3D edge and its
surface-evaluated pcurve within `1.78e-15 mm`. Each edge belongs to two faces.
`ShapeFix_Wire.FixEdgeCurves` reports a change, but rebuilding a face on the original
support with the resulting wire still gives zero area and fails validation.
`FixPeriodicDegenerated` and `FixMissingSeam` both report no change.
These measurements do not prove that every possible CAD repair is impossible.
They rule out the tested curve, seam, parameter, sewing, and general healing paths
as valid face-preserving repairs. Full-assembly engineering verification remains incomplete; partial inspection catalog registration is complete.

The captured run is in
[`poppy-head-topology.json`](cad_worker/tests/evidence/poppy-head-topology.json).
It records the source digest, original and resulting bounds, counts, integrals,
tolerances, sampled pcurves, and validity results. The diagnostic works on copies
and does not write STEP fixtures or change the transactional importer cache.

A direct neighbor check on the pinned source found that planar faces 78 and 481
both have two wires, including the radius-1.35 mm circular inner wire at the
removed boundary. The circle centers are `(46.5, 10.932446485240638,
29.409891266940623)` and `(-46.5, 10.932446485240638, 29.409891266940623)` mm.
Each boundary is represented by two semicircular arcs. Removing the zero-height
cylinders leaves a `TopAbs_SHELL` with zero solids and four free edges.
`BRepCheck_Analyzer` reports this shell valid, but `BRep_Tool.IsClosed` reports
false. It cannot be treated as a closed solid. Adding a finite wall or cap would
supply geometry absent from the STEP, while merging the circle into the
neighboring plane would remove the 2.7 mm boundary.

The historical strict-import CLI reproduction stopped at `poppy_1_28_5 (head_face)` with
`Invalid BRep topology before writing poppy_1_28_5.step`. The staged fixture
directory is removed, leaving no candidate catalog. The original signed-volume
integral is `40084.05972663066 mm³`; after face removal it is
`40084.40497993639 mm³`. Both measurements describe an invalid or open shape,
so the integral difference is not a physical volume change. The diagnostic and
source-backed test record these limits without treating removal as a repair.

## Dimensional bounds investigation

`diagnose_poppy_dimensions.py` compares triangulation-independent `AddOptimal`
bounds with freshly generated meshes at 0.2, 0.02, and 0.002 mm deflection.
It records fixture digests, per-face discrepancies, mesher status, and missing
triangulations. Run it with the fixture cache and an output JSON path.
The diagnostic does not change the source fixtures or published assets.

On `poppy_1_10`, the 19.5609 mm discrepancy persists at 0.002 mm deflection.
All faces have triangulations and the mesher status is zero.
BSpline face 51 has an `AddOptimal` maximum X of 36.5004117154 mm.
Its five boundary edges have a maximum X of 16.9186334047 mm.
A 151 by 151 UV grid, filtered through `BRepClass_FaceClassifier`, reaches
16.9186188964 mm. The same grid without trim classification reaches
36.50042246 mm. The reported bound therefore matches the underlying UV
rectangle outside the trimmed face. This supports a trim-related overestimate,
rather than a missing triangulation or a control-point hull alone.
Finite samples do not certify the global trimmed-surface extrema.
The complete part mesh reaches X = 16.9395440663 mm, with other faces included.
The mirrored foot has the same discrepancy on its minimum X bound.

The 0.3500 mm discrepancy on each motor occurrence also persists after finer
meshing. These measurements rule out ordinary mesh resolution as the explanation
for those four failures. A replacement bounds algorithm must establish trimmed
surface extrema independently of the render mesh before these failures can be
cleared. The diagnostic retains all five failures; no tolerance is relaxed.
The source geometry, IDs, catalog dimensions, and published assets are unchanged.

The captured [dimensional report](cad_worker/tests/evidence/poppy-dimensions.json)
shows all five discrepancies on BSpline faces. At 0.002 mm deflection, the
component discrepancies are 19.56086755, 19.56086755, 0.34999897,
0.34999897, and 0.15180649 mm, respectively. Every run has mesher status zero
and no missing triangulations. The report uses double-precision CAD coordinates;
the production check uses float32 render coordinates, so their last digits differ.

## Inspection explosion

Poppy inspection offsets are generated from component source centers relative to
sibling centers. Assembly centers are computed recursively from their children.
The shared animation adds each ancestor's offset to the original world placement.
Coincident centers use a deterministic SHA-256 direction keyed by occurrence ID.
These offsets are visualization controls, not mechanical assembly instructions.
The catalog retains empty assembly steps and relationships and unavailable head geometry.

An exterior-plane distance prototype using OCCT `BRepExtrema_DistShapeShape`
removed the false foot X extrema and motor discrepancies, but returned foot Y
bounds that disagree with existing mesh vertices by 0.166262 mm. Moving the plane
from 100 mm to 1 mm outside the conservative box produced the same result.
This rejects the tested solver as a reliable replacement for the bounds check.
The recorded candidate bounds are in `cad_worker/tests/evidence/poppy-plane-prototype.json`.
The production check now combines independent trimmed-edge bounds and exterior-plane
extrema with face-interior stationary points. For BSpline faces, it solves each
coordinate gradient using analytic first and second derivatives, with nine seeds
per knot span, at most 40 Newton iterations, and a gradient tolerance of 1e-8.
Only converged points classified inside or on the trimmed face contribute bounds.
This is a numerical extrema calculation, not a certified global optimization proof.
The 0.1 mm render comparison remains unchanged. CAD centering and source fixtures
still use the original conservative bounds and remain byte-for-byte unchanged.

The five cached source-part render discrepancies after correction are 0.030718,
0.030699, 0.0000012, 0.0000012, and 0.001302 mm. An analytic trimmed BSpline with
a known interior maximum checks the CAD calculation without a mesh reference.
A shifted render mesh still fails the pipeline dimensional check.
All 201 available source components pass the unchanged 0.1 mm dimensional check.
The complete-catalog maximum is 0.0563 mm. Export metadata has been refreshed.
At that milestone, the head remained unavailable, engineering validation remained
unverified, and interference analysis had not yet been run (the visual-only head
shell and reproducible interference report were added in the sections below).

## Visual-only front head shell

The renderer includes the official hardware 1.0.2 per-part
`STL_3D_printed_parts/head/head_face.STL` from
https://github.com/poppy-project/poppy-humanoid/releases/download/1.0.2/STL_3D_printed_parts.zip.
The archive SHA-256 is `c67a4e53e10b6be5c7dc29737ec7e8bfb8f299ac62c05a0659d2b9481bd5583e`;
the member SHA-256 is `af7366acad9f1ea6e5e509b9d8c4063dca5d91b8f2b60a3c9b5092082ddd37f0`.
Both are verified before rendering. Poppy project and authors retain attribution,
CC-BY-SA-4.0 applies. The source STEP and its rejection are unchanged.

This is a `visual_only` representation of stable occurrence `poppy_1_28_5`, not
CAD repair, validated manufacturing geometry, or a STEP replacement. The manifest
records its separate mesh provenance and the original CAD rejection. CAD-only
component counts and dimensional checks exclude it; rendered node mapping includes
it. No whole-head URDF mesh or procedural geometry is substituted.

The STL uses assembly Y-up millimeters, matching the placed source occurrence.
The STEP definition's occurrence placement is a -20 degree X rotation with source
translation `(0, 296.4874742048977, 24.8)` mm. The mesh requires no fitted transform.
Its source coordinates are divided by 1000 and the existing component rest position
is subtracted for local rendering; the shared renderer restores that rest position
and applies the existing ancestor explosion offsets.

The measured world bounds differ from a 0.2 mm CAD tessellation by at most
0.0401 mm. The 264,978 source triangles cover only the front shell. A deterministic
256-vertex sample in each direction gives nearest-vertex median distances of
0.0246 and 0.0717 mm, with maxima 2.2918 and 2.4644 mm. Vertex distances depend on
mesh sampling and are not surface error, CAD validity, or an equivalence proof.
The captured bounds and samples are in
`cad_worker/tests/evidence/poppy-head-visual-alignment.json`.
The source mesh remains explicitly visual-only even though its bounds align.

## Reproducible source interference report

Run `backend/.venv/bin/python backend/cad_worker/poppy_interference.py src/shared/domain/catalog/assemblies/poppy_humanoid_v1.json backend/data/open_step_cache /tmp/poppy-interference.json`.
The Poppy export pipeline also writes `interference.json` and includes the report in its validation record.
The analyzer restores source placements from the centered, digest-checked STEP fixtures.
It caches conservative CAD bounds once, filters separated pairs, then computes OCCT common volumes for candidate pairs.
Each pair runs in an isolated process with a 30 second deadline.
Boolean failures and timeouts remain unresolved rather than being counted as clear.
The report retains stable pair IDs, measured volumes, the 0.001 mm³ reporting threshold, and exclusions.
A zero or below-threshold volume does not prove a designed contact or fit.
There is no name-based intended-contact whitelist.

The rejected head and the two source-defined surface thighs remain outside volumetric analysis.
Materials, manufacturing tolerances, loads, assembly constraints and manufacturing certification remain unverified.
No source placement or geometry is changed to remove an overlap.

Local native inspection on 2026-11-25 found only Apple Command Line Tools at
`/Library/Developer/CommandLineTools`; `xcrun simctl` is unavailable.
Neither Xcode nor Android Studio is installed in `/Applications`.
`adb`, `emulator`, and `~/Library/Android/sdk` are absent.
The native scene implementations still re-export a 2D part-list fallback and there are no custom native renderer modules.
No native Poppy load, select, explode, reset or zoom interaction has been verified on this host.
No native CAD authoring application was found to perform a new source-preserving head re-export.

The export also writes `engineering.json`, tying the numerical CAD-to-render
bounds comparison and stable node mapping to the fixture provenance and interference report.
Its 0.1 mm comparison threshold is a rendering check, not a manufacturing tolerance.
Material properties, manufacturing tolerances, loads and constraints remain unknown or unverified.
The report always retains `manufacturingReadiness: not_established` for this partial source assembly.

The captured `cad_worker/tests/evidence/poppy-interference.json` analyzes 199
source solids and excludes the two surface thighs and rejected head CAD.
AABB filtering reduces 19,701 possible pairs to 595 candidates.
The original 30-second run found 101 intersections above 0.001 mm³, 491
below-threshold results and three timed-out pairs. A bounded 180-second retry
resolved all three using the same OCCT common algorithm and default settings.
Two measured 0 mm³; `poppy_1_28_1 / poppy_1_28_3` measured 115.96055272186521 mm³.
The final report records 102 intersections, 493 below-threshold results and zero
unresolved pairs. `retryHistory` preserves all original timeout results and retry
deadlines. No fuzzy tolerance, geometry repair or source change was applied.
The largest reported common volume is 486.074918567 mm³.
These are source-placement measurements, not an intended-fit classification.
No overlap has been removed by changing placement or CAD.
The report pins its input catalog and each analyzed fixture by SHA-256.

## Published inspection reports

The exporter publishes `interference.json` and `engineering.json` alongside the
regenerated render assets and pipeline result. The app validates and retains both
reports inside its validation record. Open **Inspection validation limits** for
solid and candidate counts, measured intersections, unresolved pairs, exclusions,
units and thresholds. **Measured and unresolved pairs** lists stable occurrence
IDs and measured common volumes. Below-threshold volumes are not intended-fit
classifications. Render bounds comparisons are not manufacturing tolerances.

The captured interference report can be reused only when the complete catalog
and every analyzed fixture digest match. `retry_poppy_pairs.py <output.json>`
rechecks only unresolved pairs with a bounded 180-second deadline, retaining
the original results and the retry deadline in its output. It does not change CAD.

Native verification remains unavailable on this host because Xcode, simulator,
Android SDK and emulator tooling are absent. The native scene remains a 2D
fallback. The official front-shell STL remains visual only; no valid replacement
head CAD or source-preserving repair has been established. Materials, tolerances,
loads and constraints remain unknown or unverified.
