# Canvas shell

Canvas shell opens Zappd directly to a calm full-viewport canvas with a bottom-docked prompt composer across desktop and mobile web viewports.

## Sub-features

- `shell-load` renders `/` with zero console or page errors and visible `Prompt input` and `Send` controls.
- `shell-desktop-layout` keeps the composer centered at `max-width: 712px` inside a `1280x800` desktop viewport.
- `shell-mobile-layout` adapts the composer horizontally with `16px` side padding inside a phone-sized viewport without horizontal overflow.

## How to get to it (user POV)

- Open `http://127.0.0.1:<port>/` in a desktop web browser.
- Open `http://127.0.0.1:<port>/` in a mobile web viewport.

## Driving it with T3 Preview

Preconditions:

- Zappd Metro server is healthy (`zappd-verify.mjs doctor --run-id <run-id>` exits `0`).
- `preview_open` has opened `target: { kind: "environment-port", port: <port>, path: "/" }` with `reuseExistingTab: false`, returning `tabId` (or, after two T3 Preview failures on one step, `zappd-verify.mjs browser-open --run-id <run-id> --path / --width 1280 --height 800` is active).

- **Desktop viewport.** Resize to desktop. Run `preview_resize(tabId, mode: "freeform", width: 1280, height: 800)` (or `zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 1280 --height 800`). The preview viewport resizes to `1280x800`.
- **Desktop load & tree.** Capture snapshot. Run `preview_snapshot(tabId, includeImage: true, save: true)` (or `zappd-verify.mjs browser-snapshot --run-id <run-id> --feature canvas-shell --step 01-desktop --entry-point "GET / at 1280x800" --note "0 errors; desktop composer layout"`). Accessibility tree shows `main` containing `textbox "Prompt input"` (empty) and disabled `button "Send"`, with `0` console errors and `0` page errors.
- **Desktop geometry check.** In T3 Preview, run read-only `preview_evaluate(tabId, expression: "(() => { const f = document.querySelector('form'); const m = document.querySelector('main'); const r = f.getBoundingClientRect(); return { vw: window.innerWidth, vh: window.innerHeight, mainBg: getComputedStyle(m).backgroundColor, formWidth: r.width, formBottom: r.bottom, overflowX: document.documentElement.scrollWidth > window.innerWidth }; })()")` (or read `diagnostics.formWidth`, `diagnostics.viewportWidth`, and `diagnostics.overflowX` from `browser-snapshot`). Result confirms `overflowX === false` and `formWidth <= 712`.
- **Desktop proof.** When using T3 Preview, save desktop evidence with `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs save-evidence --run-id <run-id> --feature canvas-shell --step 01-desktop --screenshot <screenshotPath> --entry-point "GET / at 1280x800" --note "0 errors; formWidth <= 712; no horizontal overflow"`. Evidence PNG and `.meta.json` are written.
- **Mobile viewport.** Switch to phone preset. Run `preview_resize(tabId, mode: "preset", preset: "iphone-14-pro-max", orientation: "portrait")` (or `zappd-verify.mjs browser-act --run-id <run-id> --action resize --width 430 --height 932`). Viewport updates to mobile dimensions.
- **Mobile snapshot & overflow check.** Run `preview_snapshot(tabId, includeImage: true, save: true)` and read-only `preview_evaluate(tabId, expression: "(() => ({ vw: window.innerWidth, formWidth: document.querySelector('form').getBoundingClientRect().width, overflowX: document.documentElement.scrollWidth > window.innerWidth }))()")` (or `zappd-verify.mjs browser-snapshot --run-id <run-id> --feature canvas-shell --step 02-mobile --entry-point "GET / at 430x932" --note "0 errors; composer fits mobile width"`). Both `Prompt input` and `Send` remain visible inside the viewport with `overflowX === false` and `0` console/page errors.
- **Mobile proof.** When using T3 Preview, save mobile evidence with `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs save-evidence --run-id <run-id> --feature canvas-shell --step 02-mobile --screenshot <screenshotPath> --entry-point "GET / at iphone-14-pro-max portrait" --note "0 errors; composer fits mobile width"`. Evidence PNG and `.meta.json` are written.

## Gotchas

- `app.json` sets `"web": { "output": "server" }`, so `/` returns SSR HTML immediately while the client bundle hydrates asynchronously; always inspect `0` console/page errors and wait for hydration (`browser-open` checks React handler attachment automatically).
- On T3 Code desktop when the main window is minimized or hidden, `preview_snapshot` can fail with `"The browser is not producing screenshot frames. For a desktop tab, show or restore the T3 Code window and try again."` After two failures on one step, close the preview tab and switch to the headless Chrome CDP fallback (`browser-open`, `browser-act`, `browser-snapshot`).
- Do not leave the preview viewport at mobile dimensions if subsequent recipes expect desktop width; resize back to `1280x800` when done.
