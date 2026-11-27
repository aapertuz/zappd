# Canvas shell

Opening an assembly displays a full-viewport obsidian studio canvas, an Assemblies back button, and a floating glass prompt composer.

## Sub-features

- `shell-load` renders an assembly route with a dark radial studio background, visible `Back to assemblies` and `Prompt input` controls, and a disabled `Send` button.
- `shell-desktop-layout` keeps `.composerDock` centered at `max-width: 712px` with `16px` horizontal padding inside a `1280x800` desktop viewport (`formWidth === 680`).
- `shell-mobile-layout` adapts `.composerDock` with `16px` side padding inside a `430x932` mobile viewport (`formWidth === 398`) without horizontal overflow.

## How to get to it (user POV)

- Open `/` in Chrome at a desktop or mobile viewport, then choose `Aero X4`.

## Driving it with Chrome (zappd-verify)

Preconditions:

- Zappd Metro server and Chrome session are healthy (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs launch`, `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-open --run-id <run-id> --path /assemblies/quadcopter_drone_v1 --width 1280 --height 800`, and `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs doctor --run-id <run-id>` exiting `0` with `checks` entry `{ name: "browserAlive", ok: true }`).
- Wait for Aero X4 with `browser-wait --run-id <run-id> --archetype quadcopter_drone_v1 --settled`. Leave the prompt draft empty.

- **Desktop load, geometry, and proof.** Capture the initial desktop snapshot by running `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature canvas-shell --step 01-desktop --entry-point "Aero X4 explorer in Chrome at 1280x800" --note "0 errors; formWidth=680 inside 712px floating glass dock; dark radial canvas; no horizontal overflow"`. Accessibility tree shows `main` containing `form` with empty `textbox "Prompt input"` and disabled `button "Send"`. Diagnostics confirm `viewportWidth === 1280`, `viewportHeight === 800`, `formWidth === 680`, `promptPlaceholder === "Ask a question or describe another CAD assembly..."`, `overflowX === false`, `assembly.archetypeId === "quadcopter_drone_v1"`, and `errors: []`. Inspect the PNG to confirm the dark obsidian radial studio gradient and translucent glass bottom composer.
- **Mobile resize.** Switch viewport to phone dimensions by running `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 430 --height 932`. Chrome viewport persists at `430x932` with `formWidth === 398` and `overflowX === false`.
- **Mobile snapshot, overflow check, and proof.** Capture mobile evidence by running `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature canvas-shell --step 02-mobile --entry-point "Aero X4 explorer in Chrome at 430x932" --note "0 errors; formWidth=398 (430 minus 32px horizontal padding); no horizontal overflow"`. Both `Prompt input` and `Send` remain visible inside the viewport with `viewportWidth === 430`, `viewportHeight === 932`, `formWidth === 398`, `overflowX === false`, and `errors: []`.
- **Restore desktop viewport.** Run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 1280 --height 800`. Diagnostics confirm `viewportWidth === 1280`, `viewportHeight === 800`, and `formWidth === 680`.

## Gotchas

- `app.json` sets `"web": { "output": "server" }`, so `/` returns SSR HTML immediately while the client bundle hydrates asynchronously. `browser-open` waits for React handler attachment before returning.
- `.composerDock` floats over `.surface` (`position: absolute; pointer-events: none; z-index: 30`) with `max-width: 712px`, `padding: 0 16px max(24px, env(safe-area-inset-bottom))`, and `box-sizing: border-box`, while `.composer` restores `pointer-events: auto`. `diagnostics.formWidth` measures the inner `<form>` (`712 - 32 = 680` on desktop, `430 - 32 = 398` on `430px` mobile).
- `browser-act --action resize` persists the viewport dimensions in `state.json`. Restore the viewport to `1280x800` after mobile checks when subsequent feature recipes reuse the same browser session.
