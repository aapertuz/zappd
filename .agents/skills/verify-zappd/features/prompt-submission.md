# Prompt submission

Prompt submission lets a user submit a non-empty prompt via the `Send` button or `Enter` key, ignores whitespace-only drafts, resets the composer height and draft, mounts `AssemblyExplorerView` via `POST /api/orchestrate`, and replaces the loaded assembly on consecutive submissions.

## Sub-features

- `submit-whitespace-noop` blocks submission on whitespace-only input when pressing `Enter` and leaves the canvas surface unmounted.
- `submit-click` submits a trimmed multiline draft when clicking `Send`, clears the composer, resets textarea height (`80 -> 56`), and loads the matched verified assembly (or missing-key error with `ProviderSwitcher`).
- `submit-enter` submits a consecutive prompt when pressing `Enter` without `Shift`, clears the composer, and replaces the loaded assembly with the newly matched archetype.
- `submit-reducer-contract` confirms trimmed `lastSubmittedPrompt` values and strictly increasing submission IDs via `pnpm run test:unit`.

## How to get to it (user POV)

- Enter a non-empty prompt in `Prompt input` in Chrome and click the `Send` button.
- Enter a second prompt in `Prompt input` in Chrome and press `Enter` without `Shift`.

## Driving it with Chrome (zappd-verify)

Preconditions:

- Zappd Metro server and Chrome session are healthy (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-open --run-id <run-id> --path / --width 1280 --height 800` and `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs doctor --run-id <run-id>` exiting `0` with `checks` entries `orchestrateEndpoint` and `browserAlive` both `ok: true`).
- Check `orchestrateEndpoint` detail from `doctor`: when `configuredProviders` is non-empty, submission resolves a verified 3D assembly; when empty, submission resolves the missing-key error and `ProviderSwitcher`.

- **Initial disabled state.** Capture the starting screen on a fresh `/`:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 01-initial --entry-point "GET / in Chrome" --note "Empty initial composer; Send disabled; no explorer mounted; 0 errors"`
    `diagnostics.promptValue === ""`, `diagnostics.sendDisabled === true`, `diagnostics.assembly === null`, and `errors: []`.
- **Whitespace Enter no-op.** Enter spaces and press `Enter`:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "   "`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
    Draft remains `"   "`, `diagnostics.sendDisabled === true`, `diagnostics.isLoadingAssembly === false`, and `diagnostics.assembly === null`.
- **Populated multiline draft before click.** Enter a 2-line quadcopter prompt and capture proof:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "Inspect quadcopter drone"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter --modifiers Shift`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "show motors and frame"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 02-draft-ready --entry-point "Type 2-line prompt into Prompt input" --note "Draft populated at 80px; Send enabled; 0 errors"`
    `diagnostics.promptHeight === 80`, `diagnostics.sendDisabled === false`, and `errors: []`.
- **Submit by click and wait for settlement.** Click `Send`, wait for `/api/orchestrate` and GLB load (or missing-key error), and capture proof:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Send"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --timeout-ms 25000`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 03-after-click-submit --entry-point "Click Send button" --note "Draft cleared; height reset 80->56; Send disabled; explorer settled; 0 errors"`
    `diagnostics.promptValue === ""`, `diagnostics.promptHeight === 56`, `diagnostics.sendDisabled === true`, and `errors: []`. With a configured key, `diagnostics.assembly.archetypeId === "quadcopter_drone_v1"`, `diagnostics.assembly.glbNodeCount > 0`, and `ariaLines` includes `region "Interactive 3D CAD Canvas"`. Without a configured key, `diagnostics.hasProviderToolbar === true` and `ariaLines` includes `Missing DEEPSEEK_API_KEY`.
- **Consecutive submit by Enter (distinct archetype).** Type a robotic-arm prompt, press `Enter`, wait for the new archetype, and capture proof:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "Build a 5-DOF SO-100 robotic arm"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
  - With a configured key, run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --archetype robotic_arm_3dof_v1 --timeout-ms 25000` (otherwise run `browser-wait --run-id <run-id> --text "Missing " --timeout-ms 15000`).
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 04-after-enter-submit --entry-point "Press Enter in Prompt input" --note "Second prompt submitted via Enter; draft cleared; assembly replaced with robotic_arm_3dof_v1; 0 errors"`
    `diagnostics.promptValue === ""`, `diagnostics.sendDisabled === true`, `diagnostics.assembly.archetypeId === "robotic_arm_3dof_v1"` (when configured), and `errors: []`.
- **Unit state confirmation.** Run `pnpm run test:unit` to confirm `reduceCanvasComposerState` records trimmed `lastSubmittedPrompt` values and strictly increasing `id`s across consecutive submissions.

## Gotchas

- `POST /api/orchestrate` sets `requireLiveApiKey: true`. Without `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, or `OPENAI_API_KEY` in `.env.local` or the environment, submission returns HTTP `400` and renders the error plus `ProviderSwitcher` state instead of the 3D scene.
- A live LLM call and GLB parse take longer than `browser-act`'s `120ms` settle delay. Always call `browser-wait` after submitting so `browser-snapshot` does not capture `"Loading verified CAD assembly…"` or the previous assembly during a consecutive submit.
- Pressing `Enter` while IME composition (`isComposing === true`) or `Shift+Enter` does not submit.
