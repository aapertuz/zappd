# Dual Scorpion source inspection

The catalog imports the 70 follower STEP parts from [momoiorg-repository/dual_scorpion](https://github.com/momoiorg-repository/dual_scorpion) at commit [`cc5b46ca9611ea5568b017bc5bff9f01945d25a3`](https://github.com/momoiorg-repository/dual_scorpion/commit/cc5b46ca9611ea5568b017bc5bff9f01945d25a3). The archive includes the Apache-2.0 license. Source files keep their upstream URLs and SHA-256 values in `src/shared/domain/catalog/assemblies/dual_scorpion_v1.json`.

## Import the source archive

Install the backend dependencies once:

```bash
python3.11 -m venv backend/.venv
uv pip install --python backend/.venv/bin/python \
  cadquery-ocp==7.8.1.1.post1 numpy==2.4.6 pygltflib==1.16.5 pytest==9.0.2
```

Import the supplied source archive and produce the app assets:

```bash
backend/.venv/bin/python backend/cad_worker/cli.py \
  --archetype dual_scorpion_v1 \
  --source-archive "/path/to/Dual Scorpion CAD STL files.zip" \
  --public-dir public/assemblies
```

The importer checks the pinned STEP names and hashes, Apache-2.0 license, URDF collision-part mapping, and URDF joint translations. It writes centered STEP fixtures to `backend/data/open_step_cache/dual_scorpion_*.step` and GLB, USDZ, STEP, manifest, and inspection-result files to `public/assemblies/dual_scorpion_v1/`. Both output directories are generated and ignored by Git.

To fetch the same commit-pinned archive instead of using a local ZIP, replace `--source-archive ...` with `--download-source`.

## Source coordinate mapping and limits

The source STEP files are in global, Z-up millimeters. Their part positions align with the source URDF collision meshes after applying the zero-pose joint translations; the largest observed bounding-box difference is under 1 mm. The importer converts each part center to the app's Y-up meter frame as `[x, z, -y]`. The original 70 STEP files remain the geometry source; the URDF mesh is used to establish stable link parents and check the source frame.

The catalog is source inspection only. It retains separate component IDs for all 70 STEP parts. The 57 parts with valid BReps are rendered from STEP; 13 motor-case STEP files fail BRep topology validation and remain explicitly unavailable. The importer does not substitute URDF meshes or leader/follower print STLs for those rejected parts, and it does not add assembly instructions or mechanical validation claims.

The design derives from SO-101. Keep the upstream Apache-2.0 license and attribution with any redistributed source or derived assets.
