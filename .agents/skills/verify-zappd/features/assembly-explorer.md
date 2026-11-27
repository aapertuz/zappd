# Assembly explorer

Assembly explorer renders a validated multi-part CAD assembly with baked PBR material skins, KiCad PCBs, COTS batteries, and OpenCascade-routed 3D cables in a full-viewport Three.js WebGL studio canvas behind a floating HUD with a top-right explode toggle, continuous explode slider, 3-state wiring visibility cycle button, zoom icon buttons, overview hover inspection with electrical circuit trace highlighting, click-to-focus smooth glide with a top-center `Back` button and 3D-anchored part callout, and a floating bottom prompt composer.

## Sub-features

- `explorer-3d-render` loads the validated GLB into a full-bleed WebGL studio canvas with geometry-driven camera framing (`webglActive === true`, `glbNodeCount === nodeCount`, `validationPassed === true`, `interferenceCount === 0`, `verificationStatus === "composed_validated"` for all three catalog assemblies with composed PCBs and routed cables, or `"sourced_verified"` for pure catalog STEP assemblies).
- `explorer-hover-inspect` hovers a 3D piece in overview (`pointerType: "mouse"`) to highlight the piece in gold, dim unrelated parts, show `status "Hovered component"` (`hoveredComponentId !== null`, `hoveredPartCallout !== null`), and highlight connected electrical peers and cables in cyan (`circuitHighlightIds.length > 0`) when hovering an electronics, power, or wiring node.
- `explorer-explode-hud` toggles `Explode (0%)` to `Explode (65%)` (`explodeFactor === 0.65`) and back to `0%`, supports continuous dragging via the `Explode factor` slider, and zooms via icon-only `Zoom out` and `Zoom in` buttons.
- `explorer-wiring-visibility` cycles the top-right wiring toggle through `Wiring visibility: Auto` (`wiringVisibility === "auto"`, auto-fading untraced cables across `explodeFactor 0.25..0.55` on open-frame assemblies and `0.48..0.72` on enclosed assemblies), `Wiring visibility: Shown` (`wiringVisibility === "show"`, `aria-pressed="true"`, visible label `"Wiring on"`), and `Wiring visibility: Hidden` (`wiringVisibility === "hide"`, visible label `"Wiring off"`).
- `explorer-shell-xray-peel` shows a 3-state `Shell` cycle button only on assemblies with `enclosureRole: "shell"` parts (`hasShell === true`, such as `reachy_mini_v1` and `open_source_rover_v1`), cycling `Shell visibility: Solid` (`"solid"`), `Shell visibility: X-ray` (`"xray"`, translucent click-through shell letting hover and click focus internal parts in place at `explodeFactor === 0`), and `Shell visibility: Hidden` (`"hidden"`), while staging `0%..40%` explode to peel outer shells before internal parts separate across `40%..100%`.
- `explorer-part-focus` clicks a 3D piece on the canvas to explode the assembly to at least `65%`, isolate the part (`isolatedComponentId === selectedComponentId`), glide the camera smoothly onto the piece (`1.1 s`), highlight connected electrical peers and cables in cyan for electronics/power nodes (`circuitHighlightIds`), show the top-center `Back` button, and render a live 3D-anchored `status "Focused component"` callout (`viewMode === "part_focus"`, `focusedPartCallout !== null`).
- `explorer-back-restore` clicks the top-center `Back` button (or presses `Escape`) to glide back (`0.65 s`) and restore the overview geometry-framed camera and previous explode factor (`viewMode === "overview"`, `selectedComponentId === null`, `isolatedComponentId === null`, `focusedPartCallout === null`).
- `explorer-mobile-layout` keeps the full-viewport 3D canvas, top-right HUD bar (including the wiring toggle), part-focus callout, and floating bottom composer usable at `430x932` without horizontal overflow (`overflowX === false`).

## How to get to it (user POV)

- Choose `Aero X4`, `Kinetix 5`, or `Nova II` on `/` to open its explorer.
- Move the pointer over 3D parts in overview to inspect part names and electrical circuit highlights.
- Click `Explode (0%)`, drag `Explode factor`, click `Wiring`, click `Zoom in` or `Zoom out`, drag the canvas to orbit, click any 3D piece to focus it, and click `Back` (or press `Escape`) to return to overview.

## Driving it with Chrome (zappd-verify)

Preconditions:

- Zappd Metro server and Chrome session are healthy (`doctor --run-id <run-id>` exits `0` with `browserAlive` `ok: true`).
- A validated assembly is loaded and its initial playback has settled (`browser-wait --run-id <run-id> --archetype quadcopter_drone_v1 --settled --timeout-ms 45000`).

- **Settled overview and geometry-framed camera proof.** Capture the settled overview baseline and record `camera.distanceMeters` (about `0.80 m` for `quadcopter_drone_v1`, `0.79 m` for `robotic_arm_3dof_v1`, `0.75 m` for `open_source_rover_v1`) plus a visible electronics node coordinate from `nodeScreenPositions` (for example `comp_quad_flight_controller`).
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 01-overview-settled --entry-point "Settled quadcopter_drone_v1 overview" --note "composed_validated, 0 interference, geometry-framed camera, baked PBR skins and routed cables visible; 0 errors"`
    Diagnostics confirm `assembly.webglActive === true`, `assembly.glbNodeCount === assembly.nodeCount`, `assembly.verificationStatus === "composed_validated"`, `assembly.validationPassed === true`, `assembly.interferenceCount === 0`, `assembly.assemblyStatus === "settled"`, `assembly.wiringVisibility === "auto"`, and `errors: []`.
- **Overview hover inspection and circuit trace proof.** Hover over an electronics/power node using coordinates from `diagnostics.assembly.nodeScreenPositions`.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action hover --x <x> --y <y>`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 02-overview-hover-circuit --entry-point "Hover 3D electronics node in overview" --note "Hovered component callout and cyan circuit trace highlight visible; 0 errors"`
    Diagnostics confirm `assembly.hoveredComponentId === "comp_quad_flight_controller"`, `assembly.hoveredPartCallout !== null`, `assembly.circuitHighlightIds.length > 0`, and `errors: []`. Inspect the PNG to confirm the gold hovered highlight, cyan connected circuit highlight, and 3D-anchored label.
- **Explode 65% preset, wiring visibility cycle, and zoom buttons proof.** Toggle explode, cycle wiring visibility through `Shown`, `Hidden`, and `Auto`, zoom in and out, then collapse.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Explode (0%)"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Wiring visibility: Auto"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 03-exploded-wiring-shown --entry-point "Click Explode (0%) then Wiring visibility: Auto" --note "explodeFactor=0.65, wiringVisibility=show, routed cables kept visible; 0 errors"`
    Diagnostics confirm `assembly.explodeFactor === 0.65`, `assembly.wiringVisibility === "show"`, `ariaLines` shows `button "Explode (65%)"` and `button "Wiring visibility: Shown"`, and `errors: []`.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Wiring visibility: Shown"` (`wiringVisibility === "hide"`)
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Wiring visibility: Hidden"` (`wiringVisibility === "auto"`)
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Zoom in"` (`camera.distanceMeters` decreases)
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Zoom out"` (`camera.distanceMeters` increases)
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Explode (65%)"` (`explodeFactor === 0`)
- **Piece click focus mode, circuit trace, and Back restoration proof.** Click a visible electronics/power piece coordinate from `nodeScreenPositions`, wait for focus settlement, capture proof, then click `Back` and confirm overview restoration.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --x <x> --y <y>`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --learning-ready explanation --timeout-ms 45000`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 04-part-focused-circuit --entry-point "Click 3D electronics piece on canvas" --note "Assembly exploded to 65%, piece isolated, camera zoomed on piece, Back button, Focused component callout, and cyan circuit peers visible; 0 errors"`
    Diagnostics confirm `assembly.viewMode === "part_focus"`, `assembly.explodeFactor >= 0.65`, `assembly.selectedComponentId !== null`, `assembly.isolatedComponentId === assembly.selectedComponentId`, `assembly.focusedPartCallout !== null`, `assembly.circuitHighlightIds.length > 0`, `ariaLines` includes `button "Back"` and `status "Focused component"`, and `errors: []`.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Back"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 05-after-back --entry-point "Click top-center Back button" --note "Overview camera and explodeFactor restored; Back and callout removed; 0 errors"`
    Diagnostics confirm `assembly.viewMode === "overview"`, `assembly.selectedComponentId === null`, `assembly.isolatedComponentId === null`, `assembly.explodeFactor === 0`, `assembly.camera.distanceMeters` matches the overview baseline recorded in step 01, `assembly.focusedPartCallout === null`, and `errors: []`.
- **Responsive mobile layout proof.** Resize the active explorer to mobile dimensions, capture proof, and restore desktop.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 430 --height 932`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-explorer --step 06-mobile-explorer --entry-point "Resize active Assembly Explorer to 430x932" --note "Mobile full-screen 3D canvas and HUD with wiring toggle, overflowX=false; 0 errors"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 1280 --height 800`
    Diagnostics confirm `viewportWidth === 430`, `overflowX === false`, and `errors: []`.

## Gotchas

- `cdp-browser.mjs` launches Chrome with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` and background-throttling disabled at `deviceScaleFactor: 1` so headless WebGL renders shaded PBR GLB frames and animations reliably. If `diagnostics.assembly.webglActive` is `false`, inspect `chrome.log`.
- Wait for the initial assembly playback to settle (`browser-wait --settled`) before reading `nodeScreenPositions` for canvas hovers and clicks.
- Focus transitions glide smoothly (`1.1 s` focus-in, `0.65 s` focus-out), while `diagnostics.assembly.camera` reports the target camera immediately. Waiting for `--learning-ready explanation` (or giving the glide a moment to settle) avoids capturing an in-flight camera frame in the PNG.
- Overview `camera.distanceMeters` is computed dynamically from the assembly's leaf bounding box (`~0.80 m` quadcopter, `~0.79 m` robotic arm, `~0.75 m` rover); `0.38 m` is only the pre-load fallback when `assembly === null`.
- Coordinate `hover` and `click` actions (`--x <x> --y <y>`) dispatch real CDP mouse events into the Three.js raycaster on the `<canvas>`. Always verify the targeted piece via `diagnostics.assembly.hoveredComponentId` or `selectedComponentId` and visual PNG inspection.
