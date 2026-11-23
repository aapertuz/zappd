# Learning callouts

Select a part to see its name and an automatic explanation. Ask a question in part focus or assembly overview to open a separate answer at the relevant part or assembly.

## Sub-features

- `focus-explanation` opens an explanation beside the Part callout.
- `focused-question` keeps the current part in focus while answering.
- `overview-question` targets a named part or the assembly as a whole.
- `source-badge` identifies On-Device, Cloud, or Cached text.
- `answer-dismissal` removes the answer and leaves the explanation visible.
- `assembly-switch` loads a different project from an explicit build prompt.

## How to get to it (user POV)

1. Submit a prompt for a supported assembly.
2. Click a visible CAD part to read its explanation, or stay in overview.
3. Enter a question in **Prompt input** and press **Send** or Enter.
4. Press **Back** to return to overview. Press **Dismiss answer** to close the answer.

## Driving it with zappd-verify

Preconditions: Launch an isolated Metro run. Run `doctor` and check that a live orchestration provider is configured. Open Chrome at 1280 × 800. In the commands below, `$verify` is `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs` and `$run` is the run ID.

- **Load the assembly.** Run `"$verify" browser-act --run-id "$run" --action type --role textbox --name "Prompt input" --text "Build a quadcopter"`, then `"$verify" browser-act --run-id "$run" --action press --key Enter`. Wait with `"$verify" browser-wait --run-id "$run" --archetype quadcopter_drone_v1`.
- **Focus a part.** Read a visible part's point from `diagnostics.assembly.nodeScreenPositions`. Run `"$verify" browser-act --run-id "$run" --action click --x "$x" --y "$y"`. Capture immediately and after the explanation settles. Check for `status "Focused component"` and `status "Component explanation"`. The callouts point to the selected part. While text is animating, `visibleLength` grows toward `fullLength`.
- **Ask in focus.** Type `How does this part connect to the rest of the assembly?` using the same **Prompt input** command and press Enter. Check that `diagnostics.assembly.focusedPartCallout` still identifies the selected part and `diagnostics.learning.answer` identifies that part and question. Verify the two annotation cards and Part label have distinct positions.
- **Ask in overview.** Run `"$verify" browser-act --run-id "$run" --action click --role button --name Back`. Ask `How does the quadcopter work?` and check that the answer targets the assembly. Ask about an exact part name and check that the next answer targets that component. The card heading identifies the target in overview.
- **Dismiss the answer.** Run `"$verify" browser-act --run-id "$run" --action click --role button --name "Dismiss answer"`. Check that `diagnostics.learning.answer` is `null`.
- **Check the mobile layout.** Run `"$verify" browser-act --run-id "$run" --action resize --width 430 --height 932`. Repeat the focus and answer actions. Check `overflowX === false` at both viewport sizes. Inspect the screenshot for clearance around the HUD, CAD part, Part label, and composer.
- **Check the source.** Compare the visible badge with `diagnostics.learning`. The badge is On-Device for `on_device`, Cloud for `cloud`, and Cached for `offline_cache`. For the cached path, load the assembly and its metadata while online, then repeat the question in an offline session without an available local model.
- **Switch projects.** Submit `Build a 5-DOF SO-100 robotic arm`. Wait with `"$verify" browser-wait --run-id "$run" --archetype robotic_arm_3dof_v1`. Check that the new project's overview has no callouts from the quadcopter.

Capture each state with `"$verify" browser-snapshot --run-id "$run" --feature learning --step "$step" --entry-point "3D Assembly Explorer and Prompt input" --note "$note"`. Inspect the PNGs and confirm `errors: []`. Run `"$verify" cleanup --run-id "$run"` when finished.

On iOS and Android development builds, follow the [native canvas setup](./native-canvas.md). Select a part from the part list and verify the explanation, then submit and dismiss a focused answer. Capture proof with T3 Device on each target.

## Gotchas

- The writing cursor can settle before a screenshot completes. Use the progress fields to distinguish a settled answer from a loading or still-writing answer.
- A tight viewport can hide the explanation while the answer is open. Dismiss the answer and check that the explanation reappears.
- Check the actual source badge on each explanation and answer. Cloud availability and on-device model support vary by run.
