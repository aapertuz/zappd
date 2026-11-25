# Prompt submission

Prompt submission lets a user submit a non-empty prompt via the `Send` button or `Enter` key, ignores whitespace-only drafts, resets the composer height and draft, mounts `AssemblyExplorerView` via `POST /api/orchestrate`, routes follow-up prompts between learning questions and explicit archetype switches, and retries orchestration when clicking a provider in `ProviderSwitcher` after an error.

## Sub-features

- `submit-whitespace-noop` blocks submission on whitespace-only input when pressing `Enter` and leaves the explorer unmounted.
- `submit-click` submits a trimmed multiline draft when clicking `Send`, clears the composer, resets textarea height (`80px` to `56px`), and loads the matched catalog assembly (or renders the missing-key alert with `ProviderSwitcher`).
- `submit-followup-routing` routes questions and non-load follow-ups on a loaded assembly to learning Q&A (`ask_question`) without reloading the scene, while explicit load commands naming a specific catalog archetype (`quadcopter_drone_v1`, `robotic_arm_3dof_v1`, or `open_source_rover_v1`) replace the loaded assembly.
- `submit-enter` submits a consecutive explicit load prompt when pressing `Enter` without `Shift`, clears the composer, and replaces the loaded assembly with the newly matched archetype.
- `submit-provider-retry` retries `POST /api/orchestrate` with `providerExplicitlySelected: true` when the user clicks `Use Google Gemini`, `Use DeepSeek`, or `Use OpenAI` in the error-state `ProviderSwitcher`.
- `submit-reducer-contract` confirms trimmed `lastSubmittedPrompt` values, increasing submission IDs, and `classifyCanvasPrompt` routing rules via `pnpm run test:unit`.

## How to get to it (user POV)

- Enter a non-empty prompt in `Prompt input` in Chrome and click the `Send` button.
- After an assembly loads, ask a question in `Prompt input` or enter an explicit build command for another archetype and press `Enter` without `Shift`.
- When orchestration returns an error, click a provider button in `ProviderSwitcher` to retry with that provider.

## Driving it with Chrome (zappd-verify)

Preconditions:

- Zappd Metro server and Chrome session are healthy (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-open --run-id <run-id> --path / --width 1280 --height 800` and `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs doctor --run-id <run-id>` exiting `0` with `checks` entries `orchestrateEndpoint` and `browserAlive` both `ok: true`).
- Check `orchestrateEndpoint` detail from `doctor`. When `configuredProviders` is non-empty, submission resolves a validated 3D assembly. When empty, submission resolves the missing-key error and `ProviderSwitcher`.

- **Initial disabled state.** Capture the starting screen on a fresh `/`.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 01-initial --entry-point "GET / in Chrome" --note "Empty initial composer; Send disabled; no explorer mounted; 0 errors"`
    `diagnostics.promptValue === ""`, `diagnostics.promptPlaceholder === "Describe a CAD assembly to explore..."`, `diagnostics.sendDisabled === true`, `diagnostics.assembly === null`, and `errors: []`.
- **Whitespace Enter no-op.** Enter spaces and press `Enter`.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "   "`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
    Draft remains `"   "`, `diagnostics.sendDisabled === true`, `diagnostics.isLoadingAssembly === false`, and `diagnostics.assembly === null`.
- **Populated multiline draft before click.** Enter a 2-line quadcopter prompt and capture proof.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "Inspect quadcopter drone"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter --modifiers Shift`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "show motors and frame"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 02-draft-ready --entry-point "Type 2-line prompt into Prompt input" --note "Draft populated at 80px; Send enabled; 0 errors"`
    `diagnostics.promptHeight === 80`, `diagnostics.sendDisabled === false`, and `errors: []`.
- **Submit by click and wait for settlement.** Click `Send`, wait for `/api/orchestrate` and GLB load (or missing-key error), and capture proof.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Send"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --timeout-ms 45000`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 03-after-click-submit --entry-point "Click Send button" --note "Draft cleared; height reset 80->56; Send disabled; explorer settled; 0 errors"`
    `diagnostics.promptValue === ""`, `diagnostics.promptHeight === 56`, `diagnostics.sendDisabled === true`, and `errors: []`. With a configured key, `diagnostics.promptPlaceholder === "Ask a question or describe another CAD assembly..."`, `diagnostics.assembly.archetypeId === "quadcopter_drone_v1"`, `diagnostics.assembly.glbNodeCount === diagnostics.assembly.nodeCount`, and `ariaLines` includes `region "Interactive 3D CAD Canvas"`. Without a configured key, `diagnostics.hasProviderToolbar === true` and `ariaLines` includes `Missing DEEPSEEK_API_KEY` (clicking `Use Google Gemini` retries and updates the alert to `Missing GEMINI_API_KEY`).
- **Consecutive submit by Enter (distinct archetype).** With a configured key, type an explicit load prompt for the SO-100 robotic arm, press `Enter`, wait for replacement settlement, and capture proof.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "Build a 5-DOF SO-100 robotic arm"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --archetype robotic_arm_3dof_v1 --settled --timeout-ms 60000`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 04-after-enter-submit --entry-point "Press Enter in Prompt input" --note "Second prompt submitted via Enter; draft cleared; assembly replaced with robotic_arm_3dof_v1; 0 errors"`
    `diagnostics.promptValue === ""`, `diagnostics.sendDisabled === true`, `diagnostics.assembly.archetypeId === "robotic_arm_3dof_v1"`, `diagnostics.assembly.glbNodeCount === diagnostics.assembly.nodeCount`, and `errors: []`.
- **Unit state confirmation.** Run `pnpm run test:unit` to confirm `reduceCanvasComposerState` (`canvas-composer.test.mjs`) and `classifyCanvasPrompt` (`learning-models.test.mjs`) contracts.

## Gotchas

- `POST /api/orchestrate` sets `requireLiveApiKey: true` and looks up `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, or `OPENAI_API_KEY` in `process.env`, `.env.local`, or `.env` (in priority order `deepseek`, `gemini`, `openai`). Without a key, submission returns HTTP `400`, clears `activeLearningContext`, and renders the alert plus `ProviderSwitcher`.
- Once an assembly is mounted, follow-up prompts without an explicit load verb and non-generic archetype keyword (for example `"quadcopter"`, `"so-100"`, or `"rover"`) route to learning Q&A instead of reloading the assembly. Generic words like `"arm"`, `"robot"`, `"wheel"`, or `"servo"` do not switch projects.
- On initial load (`assembly === null`), `AssemblyExplorerView` shows `"Loading verified CAD assembly…"` plus a `progressbar`. On replacement loads (`assembly !== null`), the prior scene stays mounted under a top overlay `progressbar` (`[role="progressbar"][aria-label="Loading verified CAD assembly"]`) with no loading text. Always pass `--archetype <new-id>` (and `--settled` when waiting for initial playback) to `browser-wait` after submitting a replacement prompt.
- Cold first orchestration plus Three.js GLB parsing in headless SwiftShader can exceed `25000 ms`; pass `--timeout-ms 45000` (or `60000` when combined with `--settled --learning-ready explanation`).
- Pressing `Enter` while IME composition (`isComposing === true`) or `Shift+Enter` does not submit.
