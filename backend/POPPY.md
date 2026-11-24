# Poppy Humanoid source import

The [Poppy hardware 1.0.2 release](https://github.com/poppy-project/poppy-humanoid/releases/tag/1.0.2) supplies a real `Poppy_Humanoid.STEP` assembly.
Its downloaded SHA-256 is `10e9d997f82787d4069f7edd4b88ec3ab6dcc51cb1686d761d84add709d38266`.

Hardware attribution belongs to the [Poppy project](https://www.poppy-project.org/) and its [authors](https://github.com/poppy-project/poppy-humanoid/blob/master/doc/authors.md).
The upstream [README](https://github.com/poppy-project/poppy-humanoid#license) licenses hardware under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
Preserve attribution and the share-alike license when redistributing derived CAD and render assets. Poppy is an upstream trademark.

## Import

Run the source adapter through the existing catalog ingestion command:

```sh
backend/.venv/bin/python backend/cad_worker/ingest_upstream_catalog.py --poppy
```

The importer rejects changed downloads and Git LFS pointers before OpenCascade reads them. It retains STEP product names, occurrence hierarchy, and composed source placements. IDs use occurrence paths within this pinned release, so repeated motor instances have different identities. IDs are not guaranteed across upstream releases.

Geometry uses the existing catalog centering and topology validation helper. Materials remain unspecified. Explode offsets remain zero until an authoritative assembly sequence supports them. No fastener relationships or build instructions are inferred from CAD product names.

A successful import writes a candidate catalog to `backend/data/poppy-catalog.json` and STEP fixtures to the existing cache. It does not register the candidate in the verified backend or frontend catalog.

## Current blocker

The pinned source fails the existing OpenCascade BRep topology check at occurrence `poppy_1_28_5`, the `head_face` product beneath the head assembly. The import stops without publishing a candidate catalog. Source geometry is not repaired, replaced, or fabricated to pass validation.

The import reached 188 cached part occurrences before this failure. These partial fixtures are not a validated assembly and must not be published as one. No GLB, USDZ, frontend catalog entry, build instructions, or engineering verification is supplied by this integration.

A source correction must preserve the upstream assembly identity and geometry and pass the existing topology, interference, dimensional, and node mapping checks before catalog registration. A successful render alone does not establish mechanical safety or correctness.

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

The integration therefore remains a rejected candidate import. Completing registration and render assets requires a valid authoritative export or a demonstrated geometry-preserving correction for those faces. None of the checked exports meets that requirement in the installed importer.

Assembly coverage was checked independently on the 1.0.2 import. All 49 assembly definitions have a one-to-one match between their direct compound children and the placed shapes of their XCAF component references (`IsSame`, including locations). No unreferenced geometry owned directly by an assembly was found in this source. The importer continues to treat assembly nodes as hierarchy and leaf nodes as geometry; this check does not establish support for arbitrary mixed-geometry assemblies from other sources.
