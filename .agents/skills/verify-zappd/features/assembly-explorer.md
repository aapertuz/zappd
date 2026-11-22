# Assembly explorer

Assembly explorer renders a verified multi-part CAD assembly in an interactive Three.js WebGL studio viewport alongside camera controls, exploded-view and stage controls, part selection, isolation, axis separation, a CAD Component Inspector, and an AI provider switcher.

## Sub-features

- `explorer-3d-render` loads the verified GLB into WebGL with studio PBR materials and edge creases (`webglActive === true`, `glbNodeCount === nodeCount`, `verificationStatus === "sourced_verified"`, `interferenceCount === 0`).
- `explorer-camera` updates spherical camera angles and distance via `Rotate left`, `Rotate right`, `Tilt up`, `Tilt down`, `Zoom in`, `Zoom out`, and restores defaults via `Reset view`.
- `explorer-explode-stages` separates assembly hierarchy layers with `Explode 25%`, `Explode 50%`, `Explode 100%`, `Collapse assembly`, `Explode factor` slider, and `Stage All` / `Stage 1 Subsystems` / `Stage 2 Parts` / `Stage 3 Subcomponents`.
- `explorer-part-inspector` selects a component from the Hierarchy list, displays its dimensions, material hint, specifications, relationships, and upstream CAD provenance in `CAD Component Inspector`, enables axis separation (`+X`, `+Y`, `+Z`, `Reset Part`), and isolates or restores visibility (`Isolate selected part` / `Show all parts`).
- `explorer-provider-switch` switches AI orchestrator models (`Use Google Gemini`, `Use DeepSeek`, `Use OpenAI`), surfaces missing-key errors with `ProviderSwitcher` for unconfigured providers, and recovers when selecting a configured provider.
- `explorer-mobile-layout` stacks the 3D viewport and manipulation panel vertically below `820px` width without horizontal overflow (`overflowX === false`).

## How to get to it (user POV)

- Submit a robotics project prompt (such as `"Inspect quadcopter drone"` or `"Build a 5-DOF SO-100 robotic arm"`) in `Prompt input` on `/` with at least one AI provider key configured in `.env.local` or the environment.
- Click camera, explode, stage, part hierarchy, manipulation, or AI provider buttons inside the `3D Assembly Explorer` region.

## Driving it with Chrome (zappd-verify)

Preconditions:

- Zappd Metro server and Chrome session are healthy (`doctor --run-id <run-id>` exits `0` with `orchestrateEndpoint` reporting at least one provider in `configuredProviders` and `browserAlive` `ok: true`). If `configuredProviders` is empty, live 3D loading is `verified-unreachable` due to missing live API key configuration.
- A verified assembly is loaded in the active Chrome tab (for example `quadcopter_drone_v1` via `prompt-submission`).

- **Camera, explode, and stage filter proof.** Orbit, zoom, explode to 100%, filter to Stage 2, and capture proof:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Rotate right"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Zoom in"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Explode 100%"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Stage 2 Parts"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 01-exploded-stage2 --entry-point "Click Rotate right, Zoom in, Explode 100%, Stage 2 Parts" --note "WebGL active; camera moved; explodeFactor=1; stage=2; 0 errors"`
    Diagnostics confirm `assembly.webglActive === true`, `assembly.glbNodeCount > 0`, `assembly.explodeFactor === 1`, `assembly.activeExplodeStage === 2`, `assembly.camera.azimuthDeg === 62`, `assembly.camera.distanceMeters === 0.3`, and `errors: []`.
- **Part selection, inspector, and axis separation proof.** Select a part from the hierarchy list, shift it along `+X`, and capture proof:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Select part Front Left Brushless Motor"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Separate part +X"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 02-part-selected --entry-point "Select Front Left Brushless Motor and click Separate part +X" --note "Inspector shows motor specs, relationships, and provenance; +X offset recorded; 0 errors"`
    Diagnostics confirm `assembly.selectedComponentId !== null`, `assembly.separatedOffsets[selectedComponentId][0] === 0.04`, `ariaLines` shows `Parent: Brushless Propulsion Subsystem`, `axial_mount`, and `STEP SHA-256`, and `errors: []`.
- **Part isolation and reset proof.** Isolate the selected part, capture proof, then restore visibility, part offset, collapse, and camera:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Isolate selected part"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 03-part-isolated --entry-point "Click Isolate selected part" --note "Single motor isolated; Show all parts button active; 0 errors"`
    Diagnostics confirm `assembly.isolatedComponentId === assembly.selectedComponentId`, `ariaLines` shows `button "Show all parts"`, and `errors: []`.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Show all parts"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Reset part position"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Collapse assembly"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Reset view"`
    Diagnostics confirm `assembly.isolatedComponentId === null`, `assembly.explodeFactor === 0`, `assembly.separatedOffsets` is `{}`, and `assembly.camera.azimuthDeg === 38`.
- **Provider error and recovery proof.** When an unconfigured provider exists (for example Google Gemini when only `deepseek` is configured), click it, verify the error and `ProviderSwitcher`, then click the configured provider to recover:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Use Google Gemini"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --text "Missing GEMINI_API_KEY" --timeout-ms 15000`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 04-provider-missing-key --entry-point "Click Use Google Gemini" --note "Missing key error and ProviderSwitcher rendered; 0 JS errors"`
    Diagnostics confirm `hasProviderToolbar === true` and `errors: []`.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Use DeepSeek"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --archetype quadcopter_drone_v1 --provider deepseek --timeout-ms 25000`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 05-provider-recovered --entry-point "Click Use DeepSeek in ProviderSwitcher" --note "Recovered 3D Assembly Explorer with DeepSeek; 0 errors"`
    Diagnostics confirm `assembly.provider === "deepseek"`, `assembly.webglActive === true`, `assembly.glbNodeCount > 0`, and `errors: []`.
- **Responsive mobile layout proof.** Resize the active explorer to mobile dimensions, capture proof, and restore desktop:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 430 --height 932`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 06-mobile-explorer --entry-point "Resize active Assembly Explorer to 430x932" --note "Stacked mobile layout with overflowX=false; 0 errors"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 1280 --height 800`
    Diagnostics confirm `viewportWidth === 430`, `overflowX === false`, and `errors: []`.

## Gotchas

- `cdp-browser.mjs` launches Chrome with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` so WebGL renders real shaded GLB frames in headless mode. If `diagnostics.assembly.webglActive` is `false`, inspect `chrome.log`.
- Part names in the Hierarchy list depend on the active archetype (`Front Left Brushless Motor` exists on `quadcopter_drone_v1`; `Main Base Housing` exists on `robotic_arm_3dof_v1`). Match the part name to the loaded archetype.
- `Part Manipulation` buttons (`Isolate`, `+X`, `+Y`, `+Z`, `Reset Part`) remain disabled until a part is selected. Clicking an already-selected part button toggles selection off.
- `browser-act --action click` on a provider button triggers a fresh `POST /api/orchestrate` request; always follow it with `browser-wait` before snapshotting.
