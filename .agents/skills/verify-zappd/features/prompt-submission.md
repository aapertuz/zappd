# Prompt submission

Prompt submission lets a user submit a non-empty prompt via the `Send` button or `Enter` key, ignores whitespace-only drafts, and resets the composer ready for the next prompt.

## Sub-features

- `submit-click` submits a trimmed non-empty draft when clicking `Send` and clears the composer.
- `submit-enter` submits a trimmed non-empty draft when pressing `Enter` without `Shift` and clears the composer.
- `submit-whitespace-noop` blocks submission on whitespace-only input when pressing `Enter` or attempting to activate `Send`.
- `submit-consecutive` accepts multiple consecutive submissions cleanly from the reset composer.

## How to get to it (user POV)

- Enter a non-empty prompt in `Prompt input` and click the `Send` button.
- Enter a non-empty prompt in `Prompt input` and press `Enter` (without `Shift`).

## Driving it with T3 Preview

Preconditions:

- Zappd Metro server is healthy (`zappd-verify.mjs doctor --run-id <run-id>` exits `0`).
- T3 Preview tab `tabId` is open on `/` — or after two T3 Preview failures on one step, headless Chrome CDP session is open (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-open --run-id <run-id> --path / --width 1280 --height 800` and `doctor --run-id <run-id>` reports `browserAlive: ok`).

- **Initial disabled state.** Capture starting screen. Run `preview_snapshot(tabId, includeImage: true, save: true)` + `save-evidence --feature prompt-submission --step 01-initial`, or run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 01-initial --entry-point "GET /" --note "Empty initial composer; Send disabled; 0 errors"`. Accessibility tree shows empty `textbox "Prompt input"`, disabled `button "Send"`, and `0` console/page errors.
- **Whitespace Enter no-op.** Type spaces and press `Enter`. Run `preview_act(tabId, action: "type", locator: "aria-ref=<inputRef>", text: "   ")`, `preview_act(tabId, action: "press", key: "Enter")`, and `preview_snapshot(tabId)` — or run:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "   "`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
    Draft remains `"   "` (not cleared and no newline added) and `Send` remains disabled.
- **Populated draft before click.** Replace spaces with a valid prompt. Run `preview_act(tabId, action: "type", locator: "aria-ref=<inputRef>", clear: true, text: "Inspect camera drone")` and `preview_snapshot(tabId, includeImage: true, save: true)` + `save-evidence --step 02-draft-ready` — or run:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "Inspect camera drone"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 02-draft-ready --entry-point "Type prompt into Prompt input" --note "Draft populated; Send enabled; 0 errors"`
    `Prompt input` shows `"Inspect camera drone"` and `Send` is enabled.
- **Submit by click.** Click `Send`. Run `preview_act(tabId, action: "click", locator: "aria-ref=<sendRef>")` and `preview_snapshot(tabId, includeImage: true, save: true)` + `save-evidence --step 03-after-click-submit` — or run:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Send"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 03-after-click-submit --entry-point "Click Send button" --note "Draft cleared; Send disabled; 0 errors"`
    `Prompt input` clears to `""`, `Send` returns to disabled, and `0` console/page errors occur.
- **Submit by Enter.** Type a second prompt and press `Enter`. Run `preview_act(tabId, action: "type", locator: "aria-ref=<inputRef>", text: "Explain brushless ESC")`, `preview_act(tabId, action: "press", key: "Enter")`, and `preview_snapshot(tabId, includeImage: true, save: true)` + `save-evidence --step 04-after-enter-submit` — or run:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "Explain brushless ESC"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 04-after-enter-submit --entry-point "Press Enter in Prompt input" --note "Second prompt submitted via Enter; draft cleared; Send disabled; 0 errors"`
    `Prompt input` clears to `""`, `Send` returns to disabled, and `0` console/page errors occur.
- **Unit state confirmation.** Run `pnpm run test:unit` to confirm `reduceCanvasComposerState` records trimmed `lastSubmittedPrompt` values and strictly increasing `id`s across consecutive submissions.

## Gotchas

- Phase 1 `src/app/index.tsx` mounts `<CanvasScreen />` without passing `onSubmitPrompt` and without rendering a submitted-prompt list in the DOM; UI evidence proves the composer transition (`draft -> ""`, `Send` enabled -> disabled, height reset) while `pnpm run test:unit` proves the reducer state mutation (`lastSubmittedPrompt`, `nextSubmissionId`).
- In T3 Preview, `aria-ref` tokens expire on every `preview_snapshot`; capture a fresh snapshot after typing `"Inspect camera drone"` to obtain the enabled `Send` button ref before clicking it.
- On T3 Code desktop when the window is minimized or hidden, `preview_snapshot` can fail with `"The browser is not producing screenshot frames. For a desktop tab, show or restore the T3 Code window and try again."` After two failures on one step, close the tab, quote the error, and use the `zappd-verify.mjs browser-*` CDP commands.
- Pressing `Enter` while IME composition (`isComposing === true`) or `Shift+Enter` does not submit.
