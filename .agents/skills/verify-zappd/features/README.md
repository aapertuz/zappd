# Zappd verification map

This directory is the maintained source for verifying the user-facing behavior of Zappd. Read this index before driving the app, then follow the matching feature recipe.

## Baseline preconditions

- Launch an isolated Zappd Expo Metro server with `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs launch` on an ephemeral port in `18081..18999`.
- Run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs doctor --run-id <run-id>` and require exit code `0` (`ok: true`) before driving any feature. Inspect the `orchestrateEndpoint` check detail to see which AI providers (`configuredProviders`) have keys configured in the environment, `.env.local`, or `.env`.
- Ensure no other active verification run owns this checkout. Run concurrent checks only in separate git worktrees, and install or link gitignored dependencies (`node_modules/`, `.env.local`, `backend/.venv/`, or precomputed `backend/data/exports/`) when testing from a clean worktree.
- Fresh `/` opens the assembly catalog. Select `Aero X4` to open the explorer and composer through `GET /api/assemblies/quadcopter_drone_v1`. This route works with an empty `configuredProviders` list.
- Never drive a Metro server or Chrome session not opened by this verification run.

## Driving conventions

- Start at `/` and select the card required by the recipe. Use `browser-open --path /assemblies/quadcopter_drone_v1` when testing a direct link. Run composer checks before editing the draft.
- Target DOM controls by ARIA roles and accessible names (`textbox "Prompt input"`, `button "Send"`, `button "Explode (0%)"`, `button "Wiring visibility: Auto"`, `button "Back"`, `button "Dismiss answer"`), never CSS selectors. Target 3D WebGL canvas meshes for `hover` and `click` using projected coordinates read from `diagnostics.assembly.nodeScreenPositions`.
- Treat helper commands verbatim and verify the live `runId`, `port`, and `errors: []` on every call.
- Wait for async `/api/orchestrate`, GLB loading, initial assembly playback, and learning callouts with `zappd-verify.mjs browser-wait` (`--archetype`, `--settled`, `--learning-ready`) before snapshotting settled states.
- Run web browser checks exclusively through Google Chrome using `zappd-verify.mjs browser-open`, `browser-act`, `browser-wait`, `browser-snapshot`, and `browser-close`. Do not use T3 Preview (`preview_*` tools) for verification.
- Run native mobile checks exclusively through T3 Device (`device_list`, `device_open`, `device_screenshot`, `device_close`) and the bound `agent-device` CLI.
- Keep proof artifacts under `/tmp/zappd-verify/evidence/<run-id>/<feature>/`. Never delete them during cleanup.

## Proof and skip reporting

- Capture both the pre-action or populated state and the post-action settled state, not only the final screen.
- Web UI proof includes visually inspected PNG screenshots, accessible tree snapshots, read-only `diagnostics` (including `diagnostics.promptPlaceholder`, `diagnostics.assembly`, and `diagnostics.learning`), and `0` console or page errors captured via `browser-snapshot --feature ... --step ...`.
- Reducer and domain state proof pairs the live web run with `pnpm run test:unit`.
- Native UI proof requires a real development build running on a simulator or emulator plus `device_screenshot`. Expo Go is not a substitute for `@expo/ui`.
- Record the feature ID and entry point in `--entry-point` and `--note` on every proof capture.
- Report any unreachable path (`verified-unreachable` or failed) with the attempted command and exact unmet precondition. Never weaken a journey to make it pass.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <tool>` starts with `Preconditions:` and uses labeled bullets pairing each user action with an exact command or tool call and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Assembly catalog](../SKILL.md#web-driver-google-chrome-via-cdp) covers card selection, direct catalog loading, reduced motion, and return navigation.
- [Canvas shell](./canvas-shell.md) covers the dark radial studio canvas, floating glass composer dock, and desktop and mobile layouts inside an assembly.
- [Prompt composer](./prompt-composer.md) covers draft typing, context-sensitive placeholder text, empty/whitespace send guarding, and multiline auto-grow.
- [Prompt submission](./prompt-submission.md) covers click and `Enter` submission, multiline height reset, `/api/orchestrate` settlement, follow-up Q&A versus project-switch routing, and error-state provider switching.
- [Assembly explorer](./assembly-explorer.md) covers WebGL 3D CAD rendering with baked PBR skins, geometry-driven camera framing, overview hover inspection, explode HUD, wiring visibility cycling, click-to-focus smooth glide with electrical circuit trace highlighting, `Back` restoration, and responsive mobile layout.
- [Learning callouts](./learning.md) covers automatic overview and part explanations, in-session cached restore, focused and overview questions, inference source badges, answer dismissal, and project switching.
- [Native canvas](./native-canvas.md) covers iOS Simulator and Android Emulator dark `@expo/ui` composer input, pre-submit keyboard dismissal, and post-submit native assembly and learning views behind dev-build preconditions.
