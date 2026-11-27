# Learning callouts

Loading a verified assembly opens an automatic plain-English overview explanation once initial playback settles, selecting a part switches that slot to an automatic part explanation beside the `Part` callout, and asking a question in part focus or overview opens a separate answer card anchored to the relevant part or root assembly. Unverified assemblies suppress learning callouts.

## Sub-features

- `overview-explanation` automatically opens an `Overview` explanation (`status "Component explanation"`, `componentId === assembly.rootNodeId`) anchored to a verified assembly once `assemblyStatus === "settled"`.
- `focus-explanation` opens an `Explanation` card (`status "Component explanation"`) beside the `Part` callout (`status "Focused component"`) when a 3D piece is selected.
- `cached-restore` restores previously completed overview and part explanations immediately (`isWriting === false`, `visibleLength === fullLength`) without replaying the typewriter animation when returning via `Back` or `Escape` or revisiting a part in the same project.
- `focused-question` keeps the current part in focus while answering in a separate `Answer` card (`status "Learning answer"`).
- `overview-question` targets a named part (`Answer · <Part Name>`) or the whole assembly (`Answer · <Root Node Name>`, for example `Answer · Quadcopter Drone Assembly`) from overview.
- `source-badge` displays `On-Device` (`on_device`), `Cloud` (`cloud`), or `Cached` (`offline_cache`) according to `inferenceSource`.
- `answer-dismissal` removes the answer card (`Dismiss answer`) and leaves the explanation card visible.
- `assembly-switch-and-rebuild-reset` clears prior callouts and cached explanations when switching assemblies (via explicit build prompt, bare catalog name, or drone promotion) or completing an in-place `/api/rebuild` parameter edit (new `projectId`), then opens a fresh `Overview` explanation for the new assembly.
- `unverified-suppression` suppresses `Overview`, `Explanation`, and `Answer` callouts when `!isVerifiedStatus(assembly.verificationStatus)` (such as `poppy_humanoid_v1`).

## How to get to it (user POV)

1. Choose a verified assembly on `/` (such as `Aero X4`) and wait for initial playback to settle so the `Overview` card appears.
2. Click a visible CAD part to read its `Explanation` card, or stay in overview.
3. Enter a question in `Prompt input` and press `Send` or `Enter`.
4. Press `Back` (or `Escape` on web) to return to overview. Press `Dismiss answer` to close the answer card.

## Driving it with Chrome (zappd-verify)

Preconditions:

- Launch an isolated Metro run (`zappd-verify.mjs launch`), open Chrome at `1280x800` (`browser-open`), and confirm `doctor --run-id <run-id>` exits `0` with `browserAlive` `ok: true`. Catalog loading and `Cached` (`offline_cache`) fallback callouts work without API keys; at least one provider in `configuredProviders` is required to verify `Cloud` (`inferenceSource === "cloud"`) responses and live `/api/route-prompt` escalation.
- Pass `--reduced-motion true` on `browser-open` when verifying settled Q&A flows under headless SwiftShader so the `54 chars/sec` typewriter reveals immediately without waiting on CPU WebGL frame pacing (omit it when specifically testing typewriter motion).
- In the commands below, `$verify` is `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs` and `$run` is the run ID.

- **Load the assembly and verify Overview explanation.** Open `Aero X4` and wait for both initial playback and the overview explanation to settle:
  - `"$verify" browser-act --run-id "$run" --action click --role button --name "Aero X4"`
  - `"$verify" browser-wait --run-id "$run" --archetype quadcopter_drone_v1 --settled --learning-ready explanation --timeout-ms 60000`
  - `"$verify" browser-snapshot --run-id "$run" --feature learning --step 01-overview-settled --entry-point "Aero X4 card to settled overview" --note "Overview explanation settled with source badge; 0 errors"`
    Diagnostics confirm `assembly.assemblyStatus === "settled"`, `learning.explanation.componentId === "proj_quadcopter"`, `learning.explanation.kind === "ready"`, `learning.explanation.isWriting === false`, `learning.explanation.visibleLength === learning.explanation.fullLength`, `learning.explanation.rect !== null`, `ariaLines` includes `status "Component explanation"` with `StaticText "OVERVIEW"`, and `errors: []`.
- **Focus a part and verify Part explanation.** Read `[x, y]` for `comp_quad_flight_controller` from `diagnostics.assembly.nodeScreenPositions`, click it, wait for the explanation to settle, and capture proof:
  - `"$verify" browser-act --run-id "$run" --action click --x "$x" --y "$y"`
  - `"$verify" browser-wait --run-id "$run" --learning-ready explanation --timeout-ms 60000`
  - `"$verify" browser-snapshot --run-id "$run" --feature learning --step 02-part-explanation --entry-point "Click 3D piece -> Part explanation" --note "Part explanation settled beside Focused component callout; 0 errors"`
    Check `status "Focused component"`, `status "Component explanation"` with `StaticText "EXPLANATION"`, `learning.explanation.componentId` matching the clicked part, and non-overlapping `explanation.rect` and `focusedPartCallout.labelPx`.
- **Ask a focused question.** Type a question in `Prompt input`, press `Enter`, wait for the answer to finish, and capture proof:
  - `"$verify" browser-act --run-id "$run" --action type --role textbox --name "Prompt input" --text "How does this part connect to the rest of the assembly?"`
  - `"$verify" browser-act --run-id "$run" --action press --key Enter`
  - `"$verify" browser-wait --run-id "$run" --learning-ready answer --timeout-ms 60000`
  - `"$verify" browser-snapshot --run-id "$run" --feature learning --step 03-focused-answer --entry-point "Ask focused question in Prompt input" --note "Focused Answer card settled beside Explanation and Part callout; 0 errors"`
    Confirm `assembly.focusedPartCallout` still identifies the selected part, `learning.answer` identifies that part and question, `ariaLines` includes `status "Learning answer"`, and all three callout cards have distinct non-overlapping positions.
- **Return to overview (cached restore) and dismiss the answer.** Click `Back` and confirm immediate cached restore of `Overview`, then click `Dismiss answer`:
  - `"$verify" browser-act --run-id "$run" --action click --role button --name "Back"`
    Diagnostics confirm `learning.explanation.componentId === "proj_quadcopter"`, `learning.explanation.isWriting === false`, and `learning.explanation.visibleLength === learning.explanation.fullLength` immediately without replaying the typewriter, while the undismissed answer remains open until dismissed.
  - `"$verify" browser-act --run-id "$run" --action click --role button --name "Dismiss answer"`
  - `"$verify" browser-snapshot --run-id "$run" --feature learning --step 04-answer-dismissed --entry-point "Click Back then Dismiss answer" --note "Answer removed while cached Overview explanation remains visible; 0 errors"`
    Confirm `learning.answer === null` and `learning.explanation.componentId === "proj_quadcopter"`.
- **Ask overview assembly and part questions.** Ask a whole-assembly question, dismiss the answer so the next `--learning-ready answer` wait cannot match the stale answer, then ask about a specific part name:
  - `"$verify" browser-act --run-id "$run" --action type --role textbox --name "Prompt input" --text "How does this drone work?"`
  - `"$verify" browser-act --run-id "$run" --action press --key Enter`
  - `"$verify" browser-wait --run-id "$run" --learning-ready answer --text "QUADCOPTER DRONE ASSEMBLY" --timeout-ms 60000`
  - `"$verify" browser-snapshot --run-id "$run" --feature learning --step 05-overview-assembly-answer --entry-point "Ask overview assembly question" --note "Targets proj_quadcopter with ANSWER · QUADCOPTER DRONE ASSEMBLY; 0 errors"`
    Confirm `learning.answer.componentId === "proj_quadcopter"` and `ariaLines` shows `ANSWER · QUADCOPTER DRONE ASSEMBLY`.
  - `"$verify" browser-act --run-id "$run" --action click --role button --name "Dismiss answer"`
  - `"$verify" browser-act --run-id "$run" --action type --role textbox --name "Prompt input" --text "What does the Front Left Brushless Motor do?"`
  - `"$verify" browser-act --run-id "$run" --action press --key Enter`
  - `"$verify" browser-wait --run-id "$run" --learning-ready answer --text "FRONT LEFT BRUSHLESS MOTOR" --timeout-ms 60000`
  - `"$verify" browser-snapshot --run-id "$run" --feature learning --step 06-overview-part-answer --entry-point "Ask overview part question" --note "Targets comp_motor_fl with ANSWER · FRONT LEFT BRUSHLESS MOTOR; 0 errors"`
    Confirm `learning.answer.componentId === "comp_motor_fl"` and `ariaLines` shows `ANSWER · FRONT LEFT BRUSHLESS MOTOR`.
- **Verify mobile layout (`430x932`) and project switch.** Check responsive stacking, then switch assemblies via a build prompt:
  - `"$verify" browser-act --run-id "$run" --action resize --width 430 --height 932`
  - `"$verify" browser-snapshot --run-id "$run" --feature learning --step 07-mobile-callouts --entry-point "Resize active learning view to 430x932" --note "Stacked overview and answer cards with overflowX=false; 0 errors"`
  - `"$verify" browser-act --run-id "$run" --action resize --width 1280 --height 800`
  - `"$verify" browser-act --run-id "$run" --action type --role textbox --name "Prompt input" --text "Build a 5-DOF SO-100 robotic arm"`
  - `"$verify" browser-act --run-id "$run" --action press --key Enter`
  - `"$verify" browser-wait --run-id "$run" --archetype robotic_arm_3dof_v1 --settled --learning-ready explanation --timeout-ms 90000`
  - `"$verify" browser-snapshot --run-id "$run" --feature learning --step 08-project-switch --entry-point "Switch to SO-100 robotic arm" --note "Prior answer cleared; fresh Overview settled for proj_robotic_arm; 0 errors"`
    Confirm `learning.answer === null`, `learning.explanation.componentId === "proj_robotic_arm"`, and `errors: []`.
- **Verify source badge and offline fallback.** Compare the visible badge (`On-Device`, `Cloud`, or `Cached`) against `diagnostics.learning.<slot>.inferenceSource` (not `contextSource`). Pair the live run with `pnpm run test:unit` (`learning-engine.test.mjs`) for offline `offline_cache` fallback verification. On iOS and Android development builds, follow [`native-canvas.md`](./native-canvas.md) to verify native `Overview`/`Explanation` and `Answer` `role="status"` cards.

## Gotchas

- Avoid asking `"How does the quadcopter work?"` when testing whole-assembly overview routing. Because `quadcopter_drone_v1` contains child parts named `"Quadcopter flight controller"` and `"Quadcopter 4-in-1 brushless ESC"`, `findPromptQuestionTarget` matches the word `"quadcopter"` to `comp_quad_flight_controller` instead of `proj_quadcopter`. Use `"How does this drone work?"` to target the root assembly.
- Callout eyebrow labels (`OVERVIEW`, `EXPLANATION`, `ANSWER · ...`) use CSS `text-transform: uppercase` inside a `<span>` (`StaticText`, not ARIA `heading`). Because `browser-wait --text` matches case-sensitive `document.body.innerText`, pass uppercase substrings such as `--text "QUADCOPTER DRONE ASSEMBLY"` or `--text "FRONT LEFT BRUSHLESS MOTOR"`.
- Always dismiss an existing answer (or match `--text`) before waiting on a second sequential overview question, because `CanvasScreen.handleSubmit` routes asynchronously and `browser-wait --learning-ready answer` can otherwise resolve immediately on the previous ready answer.
- Under headless SwiftShader without `--reduced-motion true`, Three.js CPU rendering can slow `requestAnimationFrame` to `1..2 FPS` while `useTypewriterText` clamps `dtMs <= 64 ms`, stretching a 300-character typewriter reveal past `45000 ms`. Use `--timeout-ms 60000` (or `browser-open --reduced-motion true` when not testing typewriter animation).
- `zappd-verify.mjs` has no network-offline emulation flag; offline `Cached` (`offline_cache`) inference triggers live only when `/api/learn` fails or is unreachable, and is verified deterministically via `pnpm run test:unit`.
- A tight mobile viewport can hide the explanation card (`explanation.rect === null`) while an answer card is open. Dismiss the answer and confirm the explanation card reappears.
- The source badge reflects `inferenceSource` (`on_device`, `cloud`, `offline_cache`), whereas `contextSource` records where the grounded component facts were read (`offline_cache` or `firestore`).
