# Prompt composer

Prompt composer lets a user edit a prompt draft, updates its placeholder text to match the active canvas context, guards against empty or whitespace-only sends, expands multiline drafts up to a capped scrollable height, and renders a dismissible notice banner when a modification request is unsupported.

## Sub-features

- `composer-empty-state` disables `Send` when the draft is empty in an opened assembly.
- `composer-context-placeholder` shows `"Describe a CAD assembly to explore..."` before an assembly loads or after an orchestration error clears context, `"Ask a question or describe another CAD assembly..."` in loaded overview, and `"Ask about <Part Name>..."` in part focus.
- `composer-whitespace-guard` keeps `Send` disabled when the draft contains only spaces or newlines.
- `composer-enable-send` enables `Send` as soon as the draft contains non-whitespace characters.
- `composer-multiline-grow` inserts newlines on `Shift+Enter` and grows the textarea height from `56px` up to a clamped `136px` (`max-height: 120px` content box plus `16px` padding).
- `composer-unsupported-notice` displays an inline `role="status"` notice above the composer with `button "Dismiss notice"` when prompt routing resolves to `unsupported_modify`, and clears it when clicking `Dismiss notice`, editing the draft, or submitting another prompt.

## How to get to it (user POV)

- Open an assembly, then type in `Prompt input` at the bottom of the canvas.
- Press `Shift+Enter` inside `Prompt input` to insert a newline.
- Submit an unsupported modification prompt (such as `"paint this drone red"` on `Helix Config` or `"make this rover taller"` on `Nova II`) and click `Dismiss notice` or type to clear the banner.

## Driving it with Chrome (zappd-verify)

Preconditions:

- Zappd Metro server and Chrome session are healthy (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-open --run-id <run-id> --path /assemblies/quadcopter_drone_v1 --width 1280 --height 800` and `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs doctor --run-id <run-id>` exiting `0` with `checks` entry `{ name: "browserAlive", ok: true }`).
- Wait for Aero X4 with `browser-wait --run-id <run-id> --archetype quadcopter_drone_v1 --settled --timeout-ms 60000`. Confirm an empty `promptValue`, `sendDisabled === true`, `composerNotice === null`, and `promptPlaceholder === "Ask a question or describe another CAD assembly..."`.

- **Whitespace guard (spaces and newline) and proof.** Enter spaces and a `Shift+Enter` newline into `Prompt input` and capture proof:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "   "`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter --modifiers Shift`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-composer --step 01-whitespace-disabled --entry-point "Type spaces and Shift+Enter into Prompt input" --note "Send button remains disabled on whitespace-only draft; 0 errors"`
    `diagnostics.promptValue` equals `"   \n"`, `diagnostics.promptHeight` equals `80`, `diagnostics.sendDisabled` equals `true`, and `errors` is `[]`.
- **Enable send.** Replace whitespace with non-empty text:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "Line 1"`
    `diagnostics.promptValue` equals `"Line 1"`, `diagnostics.sendDisabled` equals `false`, and `diagnostics.promptHeight` equals `56`.
- **Multiline auto-grow and proof.** Repeat `Shift+Enter` followed by typing lines `Line 2` through `Line 6` while focus remains in `Prompt input`:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter --modifiers Shift`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "Line 2"`
  - Repeat for `Line 3` through `Line 6`, then run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-composer --step 02-multiline-grow --entry-point "Shift+Enter multiline draft (6 lines)" --note "Textarea grew from 56px and clamped at 136px (max-height 120px + 16px padding); 0 errors"`.
    `diagnostics.promptValue` equals `"Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6"`, `diagnostics.promptHeight === 136`, `diagnostics.promptMaxHeight === "120px"`, `diagnostics.promptScrollHeight > diagnostics.promptHeight`, `diagnostics.promptOverflowY === "auto"`, and `errors` is `[]`.
- **Unsupported-edit notice and dismissal proof.** Submit an unsupported modification prompt, capture the notice banner, then click `Dismiss notice`:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "paint this drone red"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --text "You can edit" --timeout-ms 15000`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-composer --step 03-unsupported-notice --entry-point "Submit unsupported modify prompt" --note "Inline composerNotice visible above form with Dismiss notice button; 0 errors"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Dismiss notice"`
    `diagnostics.composerNotice` is non-null before dismissal (`ariaLines` includes `button "Dismiss notice"`) and becomes `null` after clicking `Dismiss notice`, with `errors: []`.
- **Context-sensitive placeholder check.** Verify `diagnostics.promptPlaceholder` is `"Ask a question or describe another CAD assembly..."` in assembly overview, `"Ask about <Part Name>..."` after focusing a part in `assembly-explorer`, and `"Describe a CAD assembly to explore..."` when no active assembly context is present.

## Gotchas

- `browser-act --action type` skips re-clicking the textarea center when `Prompt input` is already focused (unless `--clear` is passed), preserving the caret at the new line after `Shift+Enter`.
- Always test `Shift+Enter` via `browser-act --action press --key Enter --modifiers Shift` rather than passing literal `\n` so React's `onKeyDown` path is exercised end-to-end.
- In `CanvasView.web.tsx` and `CanvasView.module.css`, `.input` uses `line-height: 24px`, `padding: 8px 0`, `max-height: 120px`, and default `box-sizing: content-box`. The auto-grow effect assigns `textarea.scrollHeight` (which already includes `16px` vertical padding, so `40px` for one line) directly to `style.height`. Under `content-box`, `getBoundingClientRect().height` therefore starts at `56px` (`40px` content plus `16px` padding), grows to `80px` on two lines, and clamps at `136px` (`120px` max content height plus `16px` padding) with vertical scroll once overflowing.
- On web, the composer notice uses `<span role="status">`, whereas native `CanvasView.tsx` uses `accessibilityRole="alert"`.
