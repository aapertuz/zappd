# Zappd verification map

This directory is the maintained source for verifying the user-facing behavior of Zappd. Read this index before driving the app, then follow the matching feature recipe.

## Baseline preconditions

- Launch an isolated Zappd Expo Metro server with `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs launch` on an ephemeral port in `18081..18999`.
- Run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs doctor --run-id <run-id>` and require exit code `0` (`ok: true`) before driving any feature. Inspect the `orchestrateEndpoint` check detail to see which AI providers (`configuredProviders`) have keys configured in `.env.local` or the environment.
- Ensure no other active verification run owns this checkout. Run concurrent checks only in separate git worktrees.
- Fresh `/` starts with an empty in-memory prompt draft and no mounted explorer. Submitting a prompt mounts `AssemblyExplorerView` and sends `POST /api/orchestrate`, which requires at least one configured live API key (`DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, or `OPENAI_API_KEY`) to load a 3D assembly.
- Never drive a Metro server or Chrome session not opened by this verification run.

## Driving conventions

- Start every recipe from a fresh `/` route unless its preconditions state otherwise. Run empty-canvas checks (`canvas-shell`, `prompt-composer`) before submitting any prompt, or reopen a fresh Chrome tab.
- Target controls by ARIA roles and accessible names (`textbox "Prompt input"`, `button "Send"`, `button "Explode 100%"`, `button "Select part <name>"`), never raw coordinates or CSS selectors.
- Treat helper commands verbatim and verify the live `runId`, `port`, and `errors: []` on every call.
- Wait for async `/api/orchestrate` and GLB loading with `zappd-verify.mjs browser-wait` before snapshotting post-submit or provider-switch states.
- Run web browser checks exclusively through Google Chrome using `zappd-verify.mjs browser-open`, `browser-act`, `browser-wait`, `browser-snapshot`, and `browser-close`. Do not use T3 Preview (`preview_*` tools) for verification.
- Run native mobile checks exclusively through T3 Device (`device_list`, `device_open`, `device_screenshot`, `device_close`) and the bound `agent-device` CLI.
- Keep proof artifacts under `/tmp/zappd-verify/evidence/<run-id>/<feature>/`. Never delete them during cleanup.

## Proof and skip reporting

- Capture both the pre-action or populated state and the post-action settled state, not only the final screen.
- Web UI proof includes PNG screenshots, accessible tree snapshots, read-only `diagnostics` (including `diagnostics.assembly` once an assembly loads), and `0` console or page errors captured via `browser-snapshot --feature ... --step ...`.
- Reducer and domain state proof pairs the live web run with `pnpm run test:unit`.
- Native UI proof requires a real development build running on a simulator or emulator plus `device_screenshot`. Expo Go is not a substitute for `@expo/ui`.
- Record the feature ID and entry point in `--entry-point` and `--note` on every proof capture.
- Report any unreachable path (`verified-unreachable` or failed) with the attempted command and exact unmet precondition. Never weaken a journey to make it pass.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order:

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled bullets pairing each user action with an exact command or tool call and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Canvas shell](./canvas-shell.md) covers initial empty `/` load, zero-error web rendering, and desktop/mobile viewport layouts.
- [Prompt composer](./prompt-composer.md) covers draft typing, empty/whitespace send guarding, and multiline auto-grow.
- [Prompt submission](./prompt-submission.md) covers click and `Enter` submission, multiline height reset, `/api/orchestrate` settlement, and consecutive archetype replacement.
- [Assembly explorer](./assembly-explorer.md) covers WebGL 3D CAD rendering, camera controls, explode stages, part selection, isolation, axis separation, CAD component inspection, AI provider switching, and responsive layout.
- [Native canvas](./native-canvas.md) covers iOS Simulator and Android Emulator composer input, pre-submit keyboard dismissal, and post-submit native assembly surface behind dev-build preconditions.
