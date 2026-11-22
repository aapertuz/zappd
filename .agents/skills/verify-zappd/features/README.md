# Zappd verification map

This directory is the maintained source for verifying the user-facing behavior of Zappd. Read this index before driving the app, then follow the matching feature recipe.

## Baseline preconditions

- Launch an isolated Zappd Expo Metro server with `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs launch` on an ephemeral port in `18081..18999`.
- Run `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs doctor --run-id <run-id>` and require exit code `0` (`ok: true`) before driving any feature.
- Ensure no other active verification run owns this checkout; run concurrent checks only in separate git worktrees.
- Phase 1 starts at `/` with an empty in-memory prompt draft; no auth, database, or seed files are required for web verification.
- Never drive a Metro server or Chrome session not opened by this verification run.

## Driving conventions

- Start every recipe from a fresh `/` route unless its preconditions state otherwise.
- Target controls by ARIA roles and accessible names (`textbox "Prompt input"`, `button "Send"`), never raw coordinates or CSS selectors.
- Treat helper commands verbatim and verify the live `runId`, `port`, and `errors: []` on every call.
- Run web browser checks exclusively through Google Chrome using `zappd-verify.mjs browser-open`, `browser-act`, `browser-snapshot`, and `browser-close`; do not use T3 Preview (`preview_*` tools) for verification.
- Run native mobile checks exclusively through T3 Device (`device_list`, `device_open`, `device_screenshot`, `device_close`) and the bound `agent-device` CLI.
- Keep proof artifacts under `/tmp/zappd-verify/evidence/<run-id>/<feature>/`; never delete them during cleanup.

## Proof and skip reporting

- Capture both the pre-action/populated state and the post-action resulting state, not only the final screen.
- Web UI proof includes PNG screenshots, accessible tree snapshots, and `0` console/page errors captured via `browser-snapshot --feature ... --step ...`.
- Non-rendered state proof (`lastSubmittedPrompt`, monotonic submission IDs) pairs the web UI run with `pnpm run test:unit`.
- Native UI proof requires a real development build running on a simulator/emulator plus `device_screenshot`; Expo Go is not a substitute for `@expo/ui`.
- Record the feature ID and entry point in `--entry-point` and `--note` on every proof capture.
- Report any unreachable path (`verified-unreachable` or failed) with the attempted command and exact unmet precondition; never weaken a journey to make it pass.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order:

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled bullets pairing each user action with an exact command or tool call and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Canvas shell](./canvas-shell.md) covers initial load, zero-error web rendering, and desktop/mobile viewport layouts.
- [Prompt composer](./prompt-composer.md) covers draft typing, empty/whitespace send guarding, and multiline auto-grow.
- [Prompt submission](./prompt-submission.md) covers button-click and `Enter` submission, draft reset, and consecutive sends.
- [Native canvas](./native-canvas.md) covers iOS Simulator and Android Emulator input, submission, and keyboard dismissal behind dev-build preconditions.
