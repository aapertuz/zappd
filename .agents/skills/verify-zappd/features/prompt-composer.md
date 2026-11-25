# Prompt composer

Prompt composer lets a user edit a prompt draft, updates its placeholder text to match the active canvas context, guards against empty or whitespace-only sends, and expands multiline drafts up to a capped scrollable height.

## Sub-features

- `composer-empty-state` disables `Send` when the draft is empty and shows placeholder `"Describe a CAD assembly to explore..."` before an assembly loads.
- `composer-context-placeholder` switches `Prompt input` placeholder to `"Ask a question or describe another CAD assembly..."` in loaded overview and `"Ask about <Part Name>..."` in part focus.
- `composer-whitespace-guard` keeps `Send` disabled when the draft contains only spaces or newlines.
- `composer-enable-send` enables `Send` as soon as the draft contains non-whitespace characters.
- `composer-multiline-grow` inserts newlines on `Shift+Enter` and grows the textarea height from `56px` up to a clamped `136px` (`max-height: 120px` content box plus `16px` padding).

## How to get to it (user POV)

- Click or focus `Prompt input` at the bottom of the canvas in Chrome and type text.
- Press `Shift+Enter` inside `Prompt input` to insert a newline.

## Driving it with Chrome (zappd-verify)

Preconditions:

- Zappd Metro server and Chrome session are healthy (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-open --run-id <run-id> --path / --width 1280 --height 800` and `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs doctor --run-id <run-id>` exiting `0` with `checks` entry `{ name: "browserAlive", ok: true }`).
- `Prompt input` starts empty (`promptValue === ""`, `promptPlaceholder === "Describe a CAD assembly to explore..."`, `sendDisabled === true`).

- **Whitespace guard (spaces and newline) and proof.** Enter spaces and a `Shift+Enter` newline into `Prompt input` and capture proof.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "   "`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter --modifiers Shift`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-composer --step 01-whitespace-disabled --entry-point "Type spaces and Shift+Enter into Prompt input" --note "Send button remains disabled on whitespace-only draft; 0 errors"`
    `diagnostics.promptValue` equals `"   \n"`, `diagnostics.promptHeight` equals `80`, `diagnostics.sendDisabled` equals `true`, and `errors` is `[]`.
- **Enable send.** Replace whitespace with non-empty text.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "Line 1"`
    `diagnostics.promptValue` equals `"Line 1"`, `diagnostics.sendDisabled` equals `false`, and `diagnostics.promptHeight` equals `56`.
- **Multiline auto-grow and proof.** Repeat `Shift+Enter` followed by typing lines `Line 2` through `Line 6` while focus remains in `Prompt input`.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter --modifiers Shift`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "Line 2"`
  - Repeat for `Line 3` through `Line 6`, then run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-composer --step 02-multiline-grow --entry-point "Shift+Enter multiline draft (6 lines)" --note "Textarea grew from 56px and clamped at 136px (max-height 120px + 16px padding); 0 errors"`.
    `diagnostics.promptValue` equals `"Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6"`, `diagnostics.promptHeight === 136`, `diagnostics.promptMaxHeight === "120px"`, `diagnostics.promptScrollHeight > diagnostics.promptHeight`, `diagnostics.promptOverflowY === "auto"`, and `errors` is `[]`.
- **Context-sensitive placeholder check.** Verify `diagnostics.promptPlaceholder` shifts to `"Ask a question or describe another CAD assembly..."` after loading an assembly in `prompt-submission` and to `"Ask about <Part Name>..."` after focusing a part in `assembly-explorer`.

## Gotchas

- `browser-act --action type` skips re-clicking the textarea center when `Prompt input` is already focused (unless `--clear` is passed), preserving the caret at the new line after `Shift+Enter`.
- Always test `Shift+Enter` via `browser-act --action press --key Enter --modifiers Shift` rather than passing literal `\n` so React's `onKeyDown` path is exercised end-to-end.
- In `CanvasView.web.tsx` and `CanvasView.module.css`, `.input` uses `line-height: 24px`, `padding: 8px 0`, `max-height: 120px`, and default `box-sizing: content-box`. The auto-grow effect assigns `textarea.scrollHeight` (which already includes `16px` vertical padding, so `40px` for one line) directly to `style.height`. Under `content-box`, `getBoundingClientRect().height` therefore starts at `56px` (`40px` content plus `16px` padding), grows to `80px` on two lines, and clamps at `136px` (`120px` max content height plus `16px` padding) with vertical scroll once overflowing.
