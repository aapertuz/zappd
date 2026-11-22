# Canvas shell

Canvas shell opens Zappd directly to a calm full-viewport canvas with a bottom-docked prompt composer across desktop and mobile web viewports.

## Sub-features

- `shell-load` renders `/` with zero console or page errors and visible `Prompt input` and `Send` controls.
- `shell-desktop-layout` keeps the composer centered at `max-width: 712px` inside a `1280x800` desktop viewport.
- `shell-mobile-layout` adapts the composer horizontally with `16px` side padding inside a `430x932` mobile viewport without horizontal overflow.

## How to get to it (user POV)

- Open `http://127.0.0.1:<port>/` in Google Chrome at a desktop viewport.
- Open `http://127.0.0.1:<port>/` in Google Chrome at a mobile viewport.

## Driving it with Chrome (zappd-verify)

Preconditions:

- Zappd Metro server and Chrome session are healthy (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-open --run-id <run-id> --path / --width 1280 --height 800`, followed by `doctor --run-id <run-id>` exiting `0` with `browserAlive: ok`).

- **Desktop load, geometry, and proof.** Capture the initial desktop snapshot. Run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature canvas-shell --step 01-desktop --entry-point "GET / in Chrome at 1280x800" --note "0 errors; formWidth <= 712; no horizontal overflow"`. Accessibility tree shows `main` -> `form` containing empty `textbox "Prompt input"` and disabled `button "Send"`; diagnostics confirm `viewportWidth === 1280`, `viewportHeight === 800`, `formWidth <= 712`, `overflowX === false`, and `errors: []`.
- **Mobile resize.** Switch viewport to phone dimensions. Run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 430 --height 932`. Chrome viewport persists at `430x932` with `overflowX === false`.
- **Mobile snapshot, overflow check, and proof.** Capture mobile evidence. Run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature canvas-shell --step 02-mobile --entry-point "GET / in Chrome at 430x932" --note "0 errors; composer fits mobile width without overflow"`. Both `Prompt input` and `Send` remain visible inside the viewport with `viewportWidth === 430`, `viewportHeight === 932`, `formWidth <= 430`, `overflowX === false`, and `errors: []`.
- **Restore desktop viewport.** Run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 1280 --height 800`. Diagnostics confirm `viewportWidth === 1280` and `viewportHeight === 800`.

## Gotchas

- `app.json` sets `"web": { "output": "server" }`, so `/` returns SSR HTML immediately while the client bundle hydrates asynchronously; `browser-open` waits for React handler attachment before returning.
- `browser-act --action resize` persists the viewport dimensions in `state.json` so subsequent `browser-snapshot` and `browser-act` calls keep the resized viewport until resized again.
- Restore the viewport to `1280x800` after mobile checks if subsequent feature recipes run in the same browser session.
