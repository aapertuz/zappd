# Canvas shell

Canvas shell opens Zappd directly to a calm full-viewport canvas with an empty upper surface and a bottom-docked prompt composer across desktop and mobile web viewports before any prompt is submitted.

## Sub-features

- `shell-load` renders `/` with zero console or page errors, an empty surface, and visible `Prompt input` and `Send` controls.
- `shell-desktop-layout` keeps `.composerDock` centered at `max-width: 712px` with `16px` horizontal padding inside a `1280x800` desktop viewport (`formWidth === 680`).
- `shell-mobile-layout` adapts `.composerDock` with `16px` side padding inside a `430x932` mobile viewport (`formWidth === 398`) without horizontal overflow.

## How to get to it (user POV)

- Open `http://127.0.0.1:<port>/` in Google Chrome at a desktop viewport before submitting a prompt.
- Open `http://127.0.0.1:<port>/` in Google Chrome at a mobile viewport before submitting a prompt.

## Driving it with Chrome (zappd-verify)

Preconditions:

- Zappd Metro server and Chrome session are healthy (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs launch`, `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-open --run-id <run-id> --path / --width 1280 --height 800`, and `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs doctor --run-id <run-id>` exiting `0` with `checks` entry `{ name: "browserAlive", ok: true }`).
- No prompt has been submitted yet in this tab (`diagnostics.assembly === null`).

- **Desktop load, geometry, and proof.** Capture the initial desktop snapshot. Run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature canvas-shell --step 01-desktop --entry-point "GET / in Chrome at 1280x800" --note "0 errors; formWidth=680 inside 712px dock; no horizontal overflow"`. Accessibility tree shows `main` -> `form` containing empty `textbox "Prompt input"` and disabled `button "Send"` with no explorer mounted. Diagnostics confirm `viewportWidth === 1280`, `viewportHeight === 800`, `formWidth === 680`, `overflowX === false`, `assembly === null`, and `errors: []`.
- **Mobile resize.** Switch viewport to phone dimensions. Run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 430 --height 932`. Chrome viewport persists at `430x932` with `formWidth === 398` and `overflowX === false`.
- **Mobile snapshot, overflow check, and proof.** Capture mobile evidence. Run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature canvas-shell --step 02-mobile --entry-point "GET / in Chrome at 430x932" --note "0 errors; formWidth=398 (430 minus 32px horizontal padding); no horizontal overflow"`. Both `Prompt input` and `Send` remain visible inside the viewport with `viewportWidth === 430`, `viewportHeight === 932`, `formWidth === 398`, `overflowX === false`, and `errors: []`.
- **Restore desktop viewport.** Run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 1280 --height 800`. Diagnostics confirm `viewportWidth === 1280`, `viewportHeight === 800`, and `formWidth === 680`.

## Gotchas

- `app.json` sets `"web": { "output": "server" }`, so `/` returns SSR HTML immediately while the client bundle hydrates asynchronously. `browser-open` waits for React handler attachment before returning.
- Once any prompt is submitted in the active tab, `CanvasScreen` mounts `AssemblyExplorerView` inside `.surface`. Run `canvas-shell` before `prompt-submission` or reopen a fresh Chrome session with `browser-close` then `browser-open`.
- `max-width: 712px` and `padding: 0 16px` (`box-sizing: border-box`) sit on `.composerDock`, while `diagnostics.formWidth` measures the inner `<form>` (`712 - 32 = 680` on desktop, `430 - 32 = 398` on `430px` mobile).
- `browser-act --action resize` persists the viewport dimensions in `state.json`. Restore the viewport to `1280x800` after mobile checks when subsequent feature recipes reuse the same browser session.
