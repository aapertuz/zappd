# Assembly catalog

The root route `/` displays the seven Zappd CAD assemblies as selectable cards with a single shared WebGL turntable preview on web, a `Source Inspection` badge on Poppy Mark I, keyboard and hover activation, reduced-motion pause, and navigation into `/assemblies/<archetypeId>` and back.

## Sub-features

- `catalog-grid-load` renders `main` with `aria-label="Assembly catalog"`, heading `"Choose an assembly"`, all seven cards (`Aero X4`, `Kinetix 5`, `Nova II`, `Strider Q4`, `Helix Config`, `Reachy Mini`, `Poppy Mark I`), and the `Source Inspection` badge on `Poppy Mark I`.
- `catalog-turntable-switch` moves the single shared WebGL turntable to the hovered or focused card (`selector.activeTurntableArchetypeId`) while keeping `webglContexts.active <= 1`.
- `catalog-reduced-motion` pauses turntable rotation and CSS idle animation when `prefers-reduced-motion: reduce` is active (`selector.reducedMotion === true`, unchanged `turntableAngleRad` and `turntableFramesRendered`).
- `catalog-open-and-back` opens `/assemblies/<archetypeId>` when clicking a card or pressing `Enter` or `Space` on a focused card, and returns to `/` via `button "Back to assemblies"` with `webglContexts.active <= 1`.
- `catalog-unknown-route` renders `"Assembly unavailable"` with a `"Back to assemblies"` link to `/` when opening an unknown slug such as `/assemblies/does_not_exist`.
- `catalog-mobile-grid` keeps the catalog cards readable at `430x932` without horizontal overflow (`overflowX === false`).

## How to get to it (user POV)

- Open `/` in Chrome at a desktop or mobile viewport.
- Hover over a card or press `Tab` to move focus and switch the active 3D turntable.
- Click a card or press `Enter` or `Space` to open its explorer, then click `Back to assemblies` to return.
- Visit an unknown route such as `/assemblies/does_not_exist` and click `Back to assemblies`.

## Driving it with Chrome (zappd-verify)

Preconditions:

- Zappd Metro server and Chrome session are healthy (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs launch`, `browser-open --run-id <run-id> --path / --width 1280 --height 800`, and `doctor --run-id <run-id>` exiting `0` with `browserAlive` `ok: true`).
- Direct catalog loading uses `GET /api/assemblies/<archetypeId>` and works even when `configuredProviders` is empty.

- **Desktop catalog load and proof.** Capture `/` at `1280x800` by running `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-catalog --step 01-desktop --entry-point "Open / in Chrome at 1280x800" --note "7 catalog cards, single active WebGL turntable, Source Inspection badge on Poppy Mark I; 0 errors"`. Diagnostics confirm `selector.cardCount === 7`, `selector.activeTurntableArchetypeId === "quadcopter_drone_v1"`, `webglContexts.active <= 1`, `overflowX === false`, and `errors: []`. Inspect the PNG to confirm all seven cards and the `SOURCE INSPECTION` badge on `Poppy Mark I`.
- **Switch turntable by hover or keyboard.** Hover `Kinetix 5` by running `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action hover --role button --name "Kinetix 5"` (or move focus with `--action press --key Tab`). Diagnostics confirm `selector.activeTurntableArchetypeId === "robotic_arm_3dof_v1"`, `webglContexts.active <= 1`, and `errors: []`.
- **Verify reduced-motion pause.** Enable reduced motion, capture two consecutive snapshots spaced by `0.5 s`, then restore motion:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action emulate-motion --reduced-motion true`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-catalog --step 02-reduced-motion-a --entry-point "Enable prefers-reduced-motion on /" --note "First reduced-motion baseline"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-catalog --step 02-reduced-motion-b --entry-point "Second reduced-motion snapshot on /" --note "Turntable angle and frame count unchanged"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action emulate-motion --reduced-motion false`
    Both snapshots report `selector.reducedMotion === true` with identical `selector.turntableAngleRad` and `selector.turntableFramesRendered`, and `errors: []`.
- **Verify mobile catalog layout.** Resize to phone dimensions, capture proof, then restore desktop:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 430 --height 932`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-catalog --step 03-mobile --entry-point "Resize / to 430x932" --note "Mobile 2-column catalog grid with overflowX=false; 0 errors"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 1280 --height 800`
    Diagnostics confirm `viewportWidth === 430`, `overflowX === false`, `webglContexts.active <= 1`, and `errors: []`.
- **Open an assembly and return to catalog.** Click `Aero X4`, wait for settlement, then click `Back to assemblies`:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Aero X4"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --archetype quadcopter_drone_v1 --settled --timeout-ms 60000`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Back to assemblies"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --text "Choose an assembly" --timeout-ms 15000`
    URL returns to `/`, `webglContexts.active <= 1`, and `errors: []`.
- **Verify unknown-archetype fallback.** Reopen Chrome on `/assemblies/does_not_exist`, snapshot, and return via the `Back to assemblies` link:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-close --run-id <run-id>`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-open --run-id <run-id> --path /assemblies/does_not_exist --width 1280 --height 800`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature assembly-catalog --step 04-unknown-route --entry-point "Open /assemblies/does_not_exist" --note "Assembly unavailable fallback with Back to assemblies link; 0 errors"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role link --name "Back to assemblies"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --text "Choose an assembly" --timeout-ms 15000`
    Accessibility tree on `/assemblies/does_not_exist` shows `StaticText "Assembly unavailable"` and `link "Back to assemblies"`, and clicking the link restores `/`.

## Gotchas

- `AssemblySelectorView.web.tsx` mounts one shared WebGL turntable canvas and moves it between cards. Confirm `diagnostics.webglContexts.active <= 1` on `/` and across catalog-to-explorer navigation.
- On `/assemblies/does_not_exist`, the control is a `link "Back to assemblies"`, whereas inside a loaded explorer it is a `button "Back to assemblies"`.
- On native iOS and Android, `AssemblySelectorView.tsx` renders static `expo-image` PNG previews with no live WebGL turntable.
