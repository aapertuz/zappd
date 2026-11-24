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
