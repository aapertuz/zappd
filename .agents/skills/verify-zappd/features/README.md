# Zappd verification map

This directory is the maintained source for verifying the user-facing behavior of Zappd. Read this index before driving the app, then follow the matching feature recipe.

## Baseline preconditions

- Launch an isolated Zappd Expo Metro server with `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs launch` on an ephemeral port in `18081..18999`.
- Run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs doctor --run-id <run-id>` and require exit code `0` (`ok: true`) before driving any feature. Inspect the `orchestrateEndpoint` check detail to see which AI providers (`configuredProviders`) have keys configured in the environment, `.env.local`, or `.env`.
- Ensure no other active verification run owns this checkout. Run concurrent checks only in separate git worktrees. In a clean worktree, install `node_modules/` (`pnpm install --frozen-lockfile`) and link or provide gitignored runtime dependencies as needed: `.env.local` for Firebase and AI provider keys, `backend/.venv/bin/python` and `backend/data/open_step_cache/` for live `/api/rebuild` CAD worker rebuilds, and `backend/data/exports/` when testing without Firebase Storage. Avoid symlinking a full Python `site-packages` tree into `backend/.venv/` while Metro is running because Metro file scanning can exhaust Node's heap; a small wrapper script at `backend/.venv/bin/python` that `exec`s the main checkout venv avoids crawling `lib/`.
- Fresh `/` opens the seven-card assembly catalog (`Aero X4`, `Kinetix 5`, `Nova II`, `Strider Q4`, `Helix Config`, `Reachy Mini`, `Poppy Mark I`). Selecting any card opens its explorer through `GET /api/assemblies/<archetypeId>` and works even when `configuredProviders` is empty.
- Never drive a Metro server or Chrome session not opened by this verification run.

## Driving conventions

- Start at `/` and select the card required by the recipe. Use `browser-open --path /assemblies/<archetypeId>` when testing a direct link, or `--path /assemblies/does_not_exist` when testing the unavailable-assembly fallback. Run composer checks before editing the draft.
- Target DOM controls by ARIA roles and accessible names (`button "Aero X4"`, `button "Back to assemblies"`, `link "Back to assemblies"`, `textbox "Prompt input"`, `button "Send"`, `button "Dismiss notice"`, `button "Explode (0%)"`, `button "Wiring visibility: Auto"`, `button "Shell visibility: Solid"`, `button "Increase Rotor Count"`, `button "Apply parameters"`, `button "Back"`, `button "Dismiss answer"`), never CSS selectors. Target 3D WebGL canvas meshes for `hover` and `click` using projected `[x, y]` coordinates read from `diagnostics.assembly.nodeScreenPositions`.
- Treat helper commands verbatim and verify the live `runId`, `port`, and `errors: []` on every call.
- Wait for async `/api/assemblies/<archetypeId>`, `/api/orchestrate`, `/api/route-prompt`, `/api/rebuild`, GLB loading, initial assembly playback, and learning callouts with `zappd-verify.mjs browser-wait` (`--archetype`, `--settled`, `--manifest-hash-not`, `--learning-ready`, `--text`) before snapshotting settled states.
- Run web browser checks exclusively through Google Chrome using `zappd-verify.mjs browser-open`, `browser-act`, `browser-wait`, `browser-snapshot`, and `browser-close`. Do not use T3 Preview (`preview_*` tools) for verification.
- Run native mobile checks exclusively through T3 Device (`device_list`, `device_open`, `device_screenshot`, `device_close`) and the bound `agent-device` CLI.
- Keep proof artifacts under `/tmp/zappd-verify/evidence/<run-id>/<feature>/`. Never delete them during cleanup.

## Proof and skip reporting

- Capture both the pre-action or populated state and the post-action settled state, not only the final screen.
- Web UI proof includes visually inspected PNG screenshots, accessible tree snapshots, read-only `diagnostics` (including `diagnostics.promptPlaceholder`, `diagnostics.composerNotice`, `diagnostics.selector`, `diagnostics.webglContexts`, `diagnostics.assembly`, and `diagnostics.learning`), and `0` console or page errors captured via `browser-snapshot --feature ... --step ...`.
- Reducer, hybrid-router, and domain-state proof pairs the live web run with `pnpm run test:unit`.
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

- [Assembly catalog](./assembly-catalog.md) covers the seven-card `/` entry screen, single shared WebGL turntable switching, reduced-motion pause, mobile grid, navigation to `/assemblies/<archetypeId>` and back, and the `/assemblies/<unknown>` unavailable fallback.
- [Canvas shell](./canvas-shell.md) covers the dark radial studio canvas, `Back to assemblies` navigation pill, floating glass composer dock, inline unsupported-edit notice banner, and desktop and mobile responsive layouts inside an assembly.
- [Prompt composer](./prompt-composer.md) covers draft typing, context-sensitive placeholder text, empty and whitespace send guarding, multiline auto-grow, and dismissible unsupported-edit notices.
- [Prompt submission](./prompt-submission.md) covers click and `Enter` submission, multiline height reset, hybrid `/api/route-prompt` intent routing, explicit and bare-name switches across all seven catalog assemblies, drone-to-parametric promotion, in-place `/api/rebuild` parameter edits, unsupported-edit notices, and error-state provider switching.
- [Assembly explorer](./assembly-explorer.md) covers WebGL 3D CAD rendering across all seven catalog assemblies, geometry-driven camera framing, overview hover inspection, explode HUD, wiring visibility cycling, Shell X-ray and peel-back, click-to-focus smooth glide with electrical circuit trace highlighting, `Back` restoration, parametric controls and UI rebuilds, unverified warnings, Poppy Mark I partial source inspection, and responsive mobile layout.
- [Learning callouts](./learning.md) covers automatic overview and part explanations on verified assemblies, in-session cached restore, focused and overview questions, inference source badges, answer dismissal, project switching and rebuild resets, and suppression on unverified assemblies.
- [Native canvas](./native-canvas.md) covers iOS Simulator and Android Emulator catalog previews, dark `@expo/ui` composer input, inline composer notices, and native 2D assembly explorer controls behind dev-build preconditions.
