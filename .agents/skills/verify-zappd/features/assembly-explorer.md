# Assembly explorer

Assembly explorer renders a verified multi-part CAD assembly in a full-viewport Three.js WebGL studio canvas behind a floating Stark-style HUD with a top-right explode toggle, continuous explode slider, zoom icon buttons, click-to-focus part inspection with a live 3D-anchored name callout and top-center `Back` button, and a floating bottom prompt composer.

## Sub-features

- `explorer-3d-render` loads the verified GLB into a full-bleed WebGL canvas (`webglActive === true`, `glbNodeCount === nodeCount`, `verificationStatus === "sourced_verified"`, `interferenceCount === 0`) without header or sidebar chrome.
- `explorer-explode-hud` toggles `Explode (0%)` to `Explode (65%)` (`explodeFactor === 0.65`) and back to `0%`, supports continuous dragging via the `Explode factor` slider, and zooms via icon-only `Zoom in` and `Zoom out` buttons.
- `explorer-part-focus` clicks a 3D piece on the canvas to explode the assembly to at least `65%`, smoothly zoom and center the camera on the piece, show the top-center `Back` button, and render a live 3D-anchored callout label with an arrow pointing at the piece (`viewMode === "part_focus"`, `focusedPartCallout !== null`).
- `explorer-back-restore` clicks the top-center `Back` button (or presses `Escape`) to restore the overview camera and previous explode factor (`viewMode === "overview"`, `selectedComponentId === null`, `focusedPartCallout === null`).
- `explorer-mobile-layout` keeps the full-viewport 3D canvas, top-right HUD bar, part-focus callout, and floating bottom composer usable at `430x932` without horizontal overflow (`overflowX === false`).

## How to get to it (user POV)

- Submit a robotics project prompt (such as `"Inspect quadcopter drone"` or `"Build a 5-DOF SO-100 robotic arm"`) in `Prompt input` on `/` with at least one AI provider key configured in `.env.local` or the environment.
- Click `Explode (0%)`, drag `Explode factor`, click `Zoom in` or `Zoom out`, drag the canvas to orbit, click any 3D piece to focus it, and click `Back` (or press `Escape`) to return to overview.

## Driving it with Chrome (zappd-verify)

Preconditions:

- Zappd Metro server and Chrome session are healthy (`doctor --run-id <run-id>` exits `0` with `orchestrateEndpoint` reporting at least one provider in `configuredProviders` and `browserAlive` `ok: true`). If `configuredProviders` is empty, live 3D loading is `verified-unreachable` due to missing live API key configuration.
- A verified assembly is loaded and settled in the active Chrome tab (for example `quadcopter_drone_v1` via `prompt-submission`).

- **Explode 65% preset and zoom icon buttons proof.** Toggle the top-right explode preset, zoom in and out, then collapse:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Explode (0%)"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 01-exploded-65 --entry-point "Click Explode (0%)" --note "WebGL active; explodeFactor=0.65; button shows Explode (65%); 0 errors"`
    Diagnostics confirm `assembly.webglActive === true`, `assembly.glbNodeCount === assembly.nodeCount`, `assembly.explodeFactor === 0.65`, `ariaLines` shows `button "Explode (65%)"`, and `errors: []`.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Zoom in"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Zoom out"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Explode (65%)"`
    Diagnostics confirm `assembly.explodeFactor === 0` and `errors: []`.
- **Piece click focus mode and Back restoration proof.** Read a visible leaf piece coordinate from `diagnostics.assembly.nodeScreenPositions` (for example `subcomp_prop_fr`), dispatch a real canvas click, capture the focused state, then click `Back` and verify overview restoration:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --x <x> --y <y>`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 02-part-focused --entry-point "Click 3D piece on canvas" --note "Assembly exploded to 65%, camera zoomed on piece, Back button and arrow callout visible; 0 errors"`
    Diagnostics confirm `assembly.viewMode === "part_focus"`, `assembly.explodeFactor >= 0.65`, `assembly.selectedComponentId !== null`, `assembly.focusedPartCallout !== null`, `ariaLines` includes `button "Back"` and `status "Focused component"`, and `errors: []`.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Back"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 03-after-back --entry-point "Click top-center Back button" --note "Overview camera and explodeFactor restored; Back and callout removed; 0 errors"`
    Diagnostics confirm `assembly.viewMode === "overview"`, `assembly.selectedComponentId === null`, `assembly.explodeFactor === 0`, `assembly.camera.distanceMeters === 0.38`, `assembly.focusedPartCallout === null`, and `errors: []`.
- **Responsive mobile layout proof.** Resize the active explorer to mobile dimensions, capture proof, and restore desktop:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 430 --height 932`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 04-mobile-explorer --entry-point "Resize active Assembly Explorer to 430x932" --note "Mobile full-screen 3D canvas with overflowX=false; 0 errors"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 1280 --height 800`
    Diagnostics confirm `viewportWidth === 430`, `overflowX === false`, and `errors: []`.

## Gotchas

- `cdp-browser.mjs` launches Chrome with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` so WebGL renders real shaded GLB frames in headless mode. If `diagnostics.assembly.webglActive` is `false`, inspect `chrome.log`.
- Wait for the initial assembly playback to settle (`assemblyStatus === "settled"`) before reading `nodeScreenPositions` for canvas clicks.
- Coordinate clicks (`--action click --x <x> --y <y>`) dispatch real CDP mouse events into the Three.js raycaster on the `<canvas>`; always verify the clicked piece via `diagnostics.assembly.selectedComponentId` and visual PNG inspection.
