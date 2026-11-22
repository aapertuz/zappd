# Prompt submission

Prompt submission lets a user submit a non-empty prompt via the `Send` button or `Enter` key, ignores whitespace-only drafts, and resets the composer ready for the next prompt.

## Sub-features

- `submit-click` submits a trimmed non-empty draft when clicking `Send` and clears the composer.
- `submit-enter` submits a trimmed non-empty draft when pressing `Enter` without `Shift` and clears the composer.
- `submit-whitespace-noop` blocks submission on whitespace-only input when pressing `Enter` or attempting to activate `Send`.
- `submit-consecutive` accepts multiple consecutive submissions cleanly from the reset composer.

## How to get to it (user POV)

- Enter a non-empty prompt in `Prompt input` in Chrome and click the `Send` button.
- Enter a non-empty prompt in `Prompt input` in Chrome and press `Enter` (without `Shift`).

## Driving it with Chrome (zappd-verify)

Preconditions:

- Zappd Metro server and Chrome session are healthy (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-open --run-id <run-id> --path / --width 1280 --height 800`, followed by `doctor --run-id <run-id>` exiting `0` with `browserAlive: ok`).

- **Initial disabled state.** Capture the starting screen:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 01-initial --entry-point "GET / in Chrome" --note "Empty initial composer; Send disabled; 0 errors"`
    Accessibility tree shows empty `textbox "Prompt input"`, disabled `button "Send"`, `diagnostics.promptValue === ""`, `diagnostics.sendDisabled === true`, and `errors: []`.
- **Whitespace Enter no-op.** Enter spaces and press `Enter`:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "   "`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
    Draft remains `"   "` (not cleared and no newline added) and `diagnostics.sendDisabled` remains `true`.
- **Populated draft before click.** Replace spaces with a valid prompt and capture proof:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "Inspect camera drone"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 02-draft-ready --entry-point "Type prompt into Prompt input" --note "Draft populated; Send enabled; 0 errors"`
    `diagnostics.promptValue` equals `"Inspect camera drone"`, `diagnostics.sendDisabled` equals `false`, and `errors` is `[]`.
- **Submit by click.** Click `Send` and capture proof:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Send"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 03-after-click-submit --entry-point "Click Send button" --note "Draft cleared; height reset; Send disabled; 0 errors"`
    `diagnostics.promptValue` clears to `""`, `diagnostics.promptHeight` resets to single-line height (`56`), `diagnostics.sendDisabled` returns to `true`, and `errors` is `[]`.
- **Submit by Enter.** Type a second prompt, press `Enter`, and capture proof:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "Explain brushless ESC"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 04-after-enter-submit --entry-point "Press Enter in Prompt input" --note "Second prompt submitted via Enter; draft cleared; Send disabled; 0 errors"`
    `diagnostics.promptValue` clears to `""`, `diagnostics.sendDisabled` returns to `true`, and `errors` is `[]`.
- **Unit state confirmation.** Run `pnpm run test:unit` to confirm `reduceCanvasComposerState` records trimmed `lastSubmittedPrompt` values and strictly increasing `id`s across consecutive submissions.

## Gotchas

- Phase 1 `src/app/index.tsx` mounts `<CanvasScreen />` without passing `onSubmitPrompt` and without rendering a submitted-prompt list in the DOM; UI evidence proves the composer transition (`draft -> ""`, `Send` enabled -> disabled, height reset) while `pnpm run test:unit` proves the reducer state mutation (`lastSubmittedPrompt`, `nextSubmissionId`).
- Pressing `Enter` while IME composition (`isComposing === true`) or `Shift+Enter` does not submit.
