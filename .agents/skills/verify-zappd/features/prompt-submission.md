# Prompt submission

Prompt submission lets a user submit a non-empty prompt via `Send` or `Enter`, ignores whitespace-only drafts, resets the composer height and draft, classifies intent through the hybrid router (local rules plus `POST /api/route-prompt` escalation on low-confidence prompts), switches across all seven catalog assemblies via `POST /api/orchestrate`, promotes Aero X4 into Helix Config on drone parameter edits, triggers in-place `POST /api/rebuild` parameter edits on Helix Config, surfaces inline unsupported-edit notices, and retries orchestration when clicking a provider in `ProviderSwitcher` after an error.

## Sub-features

- `submit-whitespace-noop` blocks submission on whitespace-only input when pressing `Enter` and keeps the current assembly open.
- `submit-click` submits a trimmed multiline draft when clicking `Send`, clears the composer, resets textarea height (`80px` to `56px`), and loads the matched catalog assembly.
- `submit-hybrid-routing` runs `classifyCanvasPromptWithConfidence` first and escalates low-confidence prompts (polite requests, typos, multilingual load commands, hypothetical questions, ambiguous edits) to `POST /api/route-prompt` (`3000 ms` timeout, falling back deterministically on offline or HTTP `503`).
- `submit-catalog-switch` loads any of the seven catalog assemblies (`quadcopter_drone_v1`, `robotic_arm_3dof_v1`, `open_source_rover_v1`, `open_quadruped_v1`, `parametric_multirotor_v1`, `reachy_mini_v1`, `poppy_humanoid_v1`) from explicit load verbs, bare non-generic archetype names targeting a different assembly (including 1-edit typos), or multilingual load commands, while routing questions to learning Q&A (`ask_question`).
- `submit-drone-promotion` promotes `quadcopter_drone_v1` (`Aero X4`) to `parametric_multirotor_v1` (`Helix Config`) with clamped `parameterValues` when the user submits a supported multirotor parameter edit such as `"add 2 more rotors"`.
- `submit-inplace-param-rebuild` routes supported parameter edits on an active `parametric_multirotor_v1` (such as `"set wheelbase to 300mm"`) to `POST /api/rebuild` in place without calling `/api/orchestrate` or an LLM, updating `manifestHash` and `parameterValues`.
- `submit-unsupported-modify-notice` keeps the current scene mounted and renders a dismissible inline `composerNotice` banner (`role="status"` + `button "Dismiss notice"`) on `unsupported_modify`, reporting either the fixed-reference message or the editable parameter ranges.
- `submit-provider-retry` retries `POST /api/orchestrate` with `providerExplicitlySelected: true` when the user clicks `Use Google Gemini`, `Use DeepSeek`, or `Use OpenAI` in the error-state `ProviderSwitcher`.
- `submit-unit-contracts` confirms `reduceCanvasComposerState` (`canvas-composer.test.mjs`), `classifyCanvasPrompt`, `classifyCanvasPromptWithConfidence`, `resolveCanvasPromptRoute` (`learning-models.test.mjs`), `classifyPromptWithCloudProvider` (`genkit-orchestrator.test.mjs`), and `rebuildAssemblyForParameters` (`assembly-runtime-service.test.mjs`) via `pnpm run test:unit`.

## How to get to it (user POV)

- Enter a non-empty prompt in `Prompt input` in Chrome and click `Send` or press `Enter` without `Shift`.
- Request an unsupported modification on a fixed reference assembly (such as `"make this rover taller"` on `Nova II`) or on `Helix Config` (`"paint this drone red"`) to see and dismiss the inline notice.
- On `Aero X4`, request a drone parameter edit such as `"add 2 more rotors"` to promote to `Helix Config`, then submit an in-place edit such as `"set wheelbase to 300mm"`.
- Submit a catalog switch prompt (such as `"load reachy mini"` or `"Build a 5-DOF SO-100 robotic arm"`) to replace the active assembly.
- When prompt orchestration returns an error, click a provider button in `ProviderSwitcher` to retry with that provider.

## Driving it with Chrome (zappd-verify)

Preconditions:

- Zappd Metro server and Chrome session are healthy (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-open --run-id <run-id> --path /assemblies/open_source_rover_v1 --width 1280 --height 800` and `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs doctor --run-id <run-id>` exiting `0` with `orchestrateEndpoint` and `browserAlive` both `ok: true`).
- Explicit catalog switches, drone promotion, and unsupported-edit notices work even when `configuredProviders` is empty. Live in-place parameter rebuilds (`POST /api/rebuild`) require `backend/.venv/bin/python` and `backend/data/open_step_cache/`. Cloud intent routing (`/api/route-prompt`) requires a configured provider key and otherwise falls back deterministically after HTTP `503`.

- **Initial disabled state and whitespace Enter no-op.** Wait for Nova II, snapshot, then test spaces plus `Enter`:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --archetype open_source_rover_v1 --settled --timeout-ms 45000`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 01-nova-initial --entry-point "Nova II explorer in Chrome" --note "Empty initial composer; Send disabled; Nova II loaded; 0 errors"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "   "`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
    Draft stays `"   "`, `sendDisabled === true`, `isLoadingAssembly === false`, `assembly.archetypeId === "open_source_rover_v1"`, and `errors: []`.
- **Fixed-reference unsupported-edit notice and dismissal.** Submit an unsupported edit on Nova II and dismiss the banner:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "make this rover taller"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --text "fixed reference assembly" --timeout-ms 15000`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 02-fixed-unsupported-notice --entry-point "Submit 'make this rover taller' on Nova II" --note "Fixed reference notice shown; assembly unchanged; 0 errors"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Dismiss notice"`
    `diagnostics.composerNotice` equals `"NOVA2 Open-Source Rover CAD Assembly is a fixed reference assembly and does not support parameter edits."` before dismissal and `null` after, while `assembly.archetypeId` remains `"open_source_rover_v1"`.
- **Multiline click submit to Aero X4.** Type a 2-line quadcopter prompt, snapshot, click `Send`, and wait for `quadcopter_drone_v1`:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "Inspect quadcopter drone"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter --modifiers Shift`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --text "show motors and frame"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 03-multiline-draft --entry-point "Type 2-line prompt into Prompt input" --note "Draft populated at 80px; Send enabled; 0 errors"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action click --role button --name "Send"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --archetype quadcopter_drone_v1 --settled --timeout-ms 60000`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 04-after-click-submit --entry-point "Click Send button" --note "Draft cleared; height reset 80->56; Send disabled; Aero X4 settled; 0 errors"`
    `promptValue === ""`, `promptHeight === 56`, `sendDisabled === true`, `assembly.archetypeId === "quadcopter_drone_v1"`, `assembly.glbNodeCount === assembly.nodeCount`, and `errors: []`.
- **Drone-to-parametric promotion and in-place parameter rebuild via Enter.** Promote Aero X4 to 6 rotors, record `manifestHash`, then edit wheelbase in place:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "add 2 more rotors"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --archetype parametric_multirotor_v1 --settled --timeout-ms 90000`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 05-drone-promotion --entry-point "Submit 'add 2 more rotors' on Aero X4" --note "Promoted to parametric_multirotor_v1 with rotor_count=6; 0 errors"`
    Confirm `assembly.archetypeId === "parametric_multirotor_v1"`, `assembly.parameterValues.rotor_count === 6`, and record `<prev-hash>` from `assembly.manifestHash`.
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "set wheelbase to 300mm"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --manifest-hash-not <prev-hash> --timeout-ms 90000`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot --run-id <run-id> --feature prompt-submission --step 06-prompt-param-rebuild --entry-point "Submit 'set wheelbase to 300mm' on Helix Config" --note "In-place /api/rebuild updated wheelbase_mm=300 and manifestHash; 0 errors"`
    Confirm `assembly.archetypeId === "parametric_multirotor_v1"`, `assembly.parameterValues.rotor_count === 6`, `assembly.parameterValues.wheelbase_mm === 300`, `assembly.manifestHash !== <prev-hash>`, `assembly.isRebuildingParameters === false`, and `errors: []`.
- **Cross-family switch via Enter.** Switch to Reachy Mini (or SO-100 robotic arm) via `Enter`:
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action type --role textbox --name "Prompt input" --clear --text "load reachy mini"`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-act --run-id <run-id> --action press --key Enter`
  - `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --archetype reachy_mini_v1 --settled --timeout-ms 90000`
    `assembly.archetypeId === "reachy_mini_v1"`, `assembly.glbNodeCount === assembly.nodeCount`, and `errors: []`.
- **Unit state confirmation.** Run `pnpm run test:unit` to confirm `reduceCanvasComposerState`, `classifyCanvasPrompt`, `classifyCanvasPromptWithConfidence`, `resolveCanvasPromptRoute`, `classifyPromptWithCloudProvider`, and `rebuildAssemblyForParameters` contracts.

## Gotchas

- `POST /api/orchestrate` sets `requireLiveApiKey: body.providerExplicitlySelected` (not unconditionally `true`). Whenever `archetypeId` is supplied, `planProjectWithProvider` short-circuits to `local_catalog_planner` before checking API keys, and initial non-explicit prompt requests also fall back to `local_catalog_planner` when no key is configured. Missing-key HTTP `400` plus `ProviderSwitcher` only triggers when `archetypeId === undefined` and `providerExplicitlySelected === true` for an unconfigured provider (or when an upstream orchestration/asset error occurs).
- Once an assembly is mounted, explicit load commands, bare non-generic archetype names targeting a different assembly (even with a 1-edit typo), and multilingual load verbs switch assemblies, whereas questions and generic words (`"arm"`, `"robot"`, `"wheel"`, `"servo"`) route to learning Q&A.
- On initial load (`assembly === null`), `AssemblyExplorerView` shows `"Loading CAD assembly…"` plus a `progressbar`. On replacement loads (`assembly !== null`), the prior scene stays mounted under a top overlay `progressbar` (`[role="progressbar"][aria-label="Loading CAD assembly"]`) with no loading text. Always pass `--archetype <new-id> --settled` to `browser-wait` after submitting a replacement prompt, and `--manifest-hash-not <prev-hash>` after submitting an in-place parameter edit.
- Cold orchestration, first STEP rebuild, or Three.js arrival playback in headless SwiftShader can exceed `45000 ms`; pass `--timeout-ms 60000` or `90000` (or open Chrome with `--reduced-motion true` when arrival animation timing is not under test).
- Pressing `Enter` while IME composition (`isComposing === true`) or `Shift+Enter` does not submit.
