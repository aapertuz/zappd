# Prompt composer

Prompt composer lets a user edit a prompt draft, guards against empty or whitespace-only sends, and expands multiline drafts up to a capped scrollable height.

## Sub-features

- `composer-empty-state` disables `Send` when the draft is empty.
- `composer-whitespace-guard` keeps `Send` disabled when the draft contains only spaces or newlines.
- `composer-enable-send` enables `Send` as soon as the draft contains non-whitespace characters.
- `composer-multiline-grow` inserts newlines on `Shift+Enter` and grows the textarea height up to `max-height: 120px`.

## How to get to it (user POV)

- Click or focus `Prompt input` at the bottom of the canvas and type text.
- Press `Shift+Enter` inside `Prompt input` to insert a newline.

## Driving it with T3 Preview

Preconditions:

- Zappd Metro server is healthy (`zappd-verify.mjs doctor --run-id <run-id>` exits `0`).
- T3 Preview tab `tabId` is open on `/` with an empty `Prompt input` (or `zappd-verify.mjs browser-open --run-id <run-id> --path /` is active after two T3 Preview failures).

- **Initial empty state.** Capture baseline. Run `preview_snapshot(tabId, includeImage: true, save: true)` (or `zappd-verify.mjs browser-snapshot --run-id <run-id>`). `textbox "Prompt input"` is empty and `button "Send"` has `disabled: true`.
- **Whitespace guard.** Click and enter spaces. Run `preview_act(tabId, action: "type", locator: "aria-ref=<inputRef>", text: "   ")` and `preview_snapshot(tabId, includeImage: true, save: true)` (or `zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "   "` + `browser-snapshot --feature prompt-composer --step 01-whitespace-disabled ...`). `Prompt input` holds `"   "` and `button "Send"` remains disabled.
- **Whitespace proof.** In T3 Preview, run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs save-evidence --run-id <run-id> --feature prompt-composer --step 01-whitespace-disabled --screenshot <screenshotPath> --entry-point "Type spaces into Prompt input" --note "Send button remains disabled"`. Artifact is written.
- **Enable send.** Replace with non-empty text. Run `preview_act(tabId, action: "type", locator: "aria-ref=<inputRef>", clear: true, text: "Build a camera drone")` and `preview_snapshot(tabId, includeImage: true, save: true)` (or `zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "Build a camera drone"`). `Prompt input` shows `"Build a camera drone"` and `button "Send"` is enabled (`disabled` absent).
- **Multiline auto-grow.** Measure initial height via read-only `preview_evaluate` (or `diagnostics.promptHeight` from `browser-act`), then press `Shift+Enter` and insert 5 additional lines (`preview_act(tabId, action: "press", key: "Enter", modifiers: ["Shift"])` or `zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter --modifiers Shift` interleaved with typing lines 2 through 6). Capture `preview_snapshot(tabId, includeImage: true, save: true)` and read-only `preview_evaluate` (or `browser-snapshot --feature prompt-composer --step 02-multiline-grow ...`). Height increases above the initial single-line height and clamps at `max-height: 120px` while `scrollHeight > height` with `overflowY === 'auto'`.
- **Multiline proof.** In T3 Preview, run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs save-evidence --run-id <run-id> --feature prompt-composer --step 02-multiline-grow --screenshot <screenshotPath> --entry-point "Shift+Enter multiline draft" --note "Height grew and clamped at max-height 120px"`. Artifact is written.

## Gotchas

- In T3 Preview, `aria-ref` values invalidate after every `preview_snapshot`; always read the newest snapshot before calling `preview_act`.
- `press` sends keys to the currently focused element; focus `Prompt input` by typing or clicking it before calling `press`.
- Test `Shift+Enter` with `press` (`modifiers: ["Shift"]` / `--modifiers Shift`) to prove the keyboard newline path does not trigger submission.
- If T3 Preview fails twice with `"The browser is not producing screenshot frames..."`, close the tab, quote the error, and use `zappd-verify.mjs browser-*` commands.
