---
name: verify-zappd
description: 'Verify the Zappd Expo application end-to-end as a user: launch an isolated Expo Metro web server, health-check it, drive the web canvas in T3 Preview (or the built-in headless Chrome CDP fallback, or native simulator/emulator builds via T3 Device and agent-device), capture surviving proof artifacts, and clean up. Reach for this whenever proving Zappd UI, composer, or platform behavior.'
---

# Verify Zappd

Zappd is an Expo SDK 58 + Expo Router application (`src/app/index.tsx` -> `CanvasScreen` -> `CanvasView`).

- **Primary surface:** Web UI served by Expo Metro on `http://127.0.0.1:<port>/` (`CanvasView.web.tsx`, React DOM + CSS Modules).
- **Secondary surface:** Native iOS and Android UI (`CanvasView.tsx`, universal `@expo/ui`). `ios/` and `android/` are CNG-generated and absent in a clean checkout, so native verification requires a local development build (`pnpm exec expo run:ios` or `pnpm exec expo run:android`). See [`features/native-canvas.md`](features/native-canvas.md).
- **Isolation:** Each checkout shares `.expo/`, so the helper allows only one active verification server per checkout realpath and refuses to double-drive an active run. Concurrent runs in separate git worktrees work independently on distinct ephemeral ports (`18081..18999`). Never touch developer port `8081`.
- **Scratch vs. evidence:** Run state (`state.json`, `metro.log`, `chrome-profile/`, `chrome.log`) lives under `/tmp/zappd-verify/runs/<run-id>/` and is deleted by cleanup. Proof artifacts live under `/tmp/zappd-verify/evidence/<run-id>/<feature>/` and survive cleanup.

## Launch

Start an isolated Expo Metro server bound to `127.0.0.1` on a free port in `18081..18999` (never passes `--web`, sets `EXPO_NO_TELEMETRY=1` and `BROWSER=none`, and omits `CI=1` so Fast Refresh stays active):

```bash
./.agents/skills/verify-zappd/scripts/zappd-verify.mjs launch
```

- **Underlying command:** `node <expo/bin/cli> start --localhost --port <port>` in the repository root.
- **Usable readiness criteria:** `launch` waits (default `--timeout-ms 60000`) until:
  1. `GET /status` returns `200` with body `packager-status:running` and `X-React-Native-Project-Root` matching the checkout realpath.
  2. `GET /` returns `200` (`text/html`) containing `aria-label="Prompt input"` and `aria-label="Send"`.
  3. The preloaded client `entry.bundle` URL in `/` compiles and returns `200`.
- **Migrations & seed data:** Phase 1 holds composer state in memory (`src/features/canvas/model/composerState.ts`); no database, migrations, auth session, or seed files are required.
- **Output:** JSON containing `runId`, `pid`, `port`, `url`, `gitHead`, `logPath`, and `evidenceDir`. Always run `cleanup --run-id <run-id>` when done or after any failure.

## Doctor

Before driving the first feature and immediately after any unexpected failure, run the read-only health check:

```bash
./.agents/skills/verify-zappd/scripts/zappd-verify.mjs doctor --run-id <run-id>
```

It exits `0` only when all checks pass:

1. `processAlive` — recorded PID is alive and its `ps` command line is `expo` on `--port <port>`.
2. `portOwner` — `lsof` confirms the recorded PID owns `127.0.0.1:<port>`.
3. `statusEndpoint` — `GET /status` returns `packager-status:running` for this exact checkout realpath.
4. `rootRouteRender` — `GET /` returns `200` HTML with `Prompt input` and `Send`.
5. `gitRevisionMatch` — `git rev-parse HEAD` matches the revision recorded at launch.
6. `evidenceDirExists` — `/tmp/zappd-verify/evidence/<run-id>/` exists.
7. `browserAlive` (present when `browser-open` is active) — recorded Chrome PID owns its isolated `--user-data-dir` profile and its CDP `/json/version` endpoint returns `200`.

## Drive

Read [`features/README.md`](features/README.md) first, then follow the matching recipe under [`features/`](features/).

### Primary web driver: T3 Preview

1. Check existing preview tabs with `preview_status`.
2. Open a dedicated tab owned by this run with `preview_open`:
   - `target: { kind: "environment-port", port: <port>, path: "/" }`
   - `reuseExistingTab: false` (retain the returned `tabId`).
3. Take `preview_snapshot` (`includeImage: true, save: true`) before interacting to capture the initial accessible tree, screenshot path, and console/page diagnostics.
4. Target controls strictly via `aria-ref=<ref>` from the most recent `preview_snapshot` using `preview_act`:
   - Prompt field: `textbox "Prompt input"`
   - Submit control: `button "Send"`
   - Resize desktop/mobile viewports with `preview_resize`.
   - Use `preview_evaluate` strictly for read-only layout/CSS assertions (such as `scrollHeight` or bounding rects); never mutate React/DOM state with JavaScript.
5. Refresh `preview_snapshot` after any navigation or DOM update because `aria-ref` tokens expire on every snapshot.

### Headless Chrome CDP fallback

If `preview_*` tools are unavailable or two preview calls fail on the same step (for example, desktop-window screenshot stalls reporting `"The browser is not producing screenshot frames. For a desktop tab, show or restore the T3 Code window and try again."`), close any open preview tab, quote the exact error, and switch to the built-in headless Chrome CDP commands in `zappd-verify.mjs`:

1. `browser-open --run-id <run-id> --path / --width 1280 --height 800` (waits for React hydration on `Prompt input` and `Send` before returning).
2. Re-run `doctor --run-id <run-id>` so `browserAlive` is verified too.
3. Drive by accessible role and name (`--role textbox --name "Prompt input"`, `--role button --name "Send"`) via `browser-act --run-id <run-id> ...` and capture screenshots + ARIA trees via `browser-snapshot --run-id <run-id> --feature <slug> --step <step> ...`.
4. Close the browser session with `browser-close --run-id <run-id>` (or let `cleanup --run-id <run-id>` tear down both Chrome and Metro).

### Native driver

For native iOS/Android verification, follow [`features/native-canvas.md`](features/native-canvas.md) using T3 `device_list`, `device_open`, the bound `agent-device` CLI, and `device_screenshot` (never raw `xcrun simctl`, `idb`, or `adb` for UI driving).

## Evidence

Store all proof artifacts under `/tmp/zappd-verify/evidence/<run-id>/<feature>/` either with `save-evidence` (when using T3 Preview or `device_screenshot`):

```bash
./.agents/skills/verify-zappd/scripts/zappd-verify.mjs save-evidence \
  --run-id <run-id> \
  --feature <feature-slug> \
  --step <step-name> \
  --screenshot <preview-screenshot-png> \
  --snapshot-file <aria-snapshot-txt> \
  --entry-point "<user entry point>" \
  --note "<observed state and 0-error check>"
```

Or directly via `browser-snapshot --run-id <run-id> --feature <feature-slug> --step <step-name> --entry-point "<user entry point>" --note "<observed state>"` when using the headless Chrome CDP fallback (writes `<step>.png`, `<step>.aria.txt`, and `<step>.meta.json`).

Proof standards:

- Drive only real user interactions (`preview_act`, `browser-act`, keyboard events, real clicks); never bypass controls via internal state hooks or state-mutating JS evaluation.
- Capture **both** the action/pre-submit state and the resulting state (not just the end screen), including console/page error counts.
- Pair web `prompt-submission` UI proofs with `pnpm run test:unit` (`tests/canvas-composer.test.mjs`) to verify non-rendered reducer state (`lastSubmittedPrompt`, monotonic `id`) until a visible prompt feed exists in `src/app/index.tsx`.
- If a precondition is unmet (such as no built native app for `native-canvas.md`), report the feature as failed/`verified-unreachable` with the unmet precondition and never weaken the journey.

## Cleanup

Tear down only the instance, browser, and tab created by this run:

1. Close your preview tab with `t3_preview_close(tabId)` (or `device_close` if a device panel was opened).
2. Stop the run's headless Chrome session (if opened) and Expo Metro server, and delete `/tmp/zappd-verify/runs/<run-id>/`:

```bash
./.agents/skills/verify-zappd/scripts/zappd-verify.mjs cleanup --run-id <run-id>
```

- `cleanup` verifies PID command-line ownership for both Chrome (`--user-data-dir=...`) and Expo (`--port ...`) before signaling `SIGTERM` (escalating to `SIGKILL` only for those verified PIDs if still alive), waits for ports to close, and never kills by process name.
- Confirm after cleanup that `/tmp/zappd-verify/runs/<run-id>/` is gone and your proof artifacts under `/tmp/zappd-verify/evidence/<run-id>/` remain intact.

## Helpers

Executable helper: [`.agents/skills/verify-zappd/scripts/zappd-verify.mjs`](scripts/zappd-verify.mjs) (with CDP module [`scripts/cdp-browser.mjs`](scripts/cdp-browser.mjs))

- `launch [--run-id <id>] [--port <port>] [--timeout-ms <ms>]` — start an isolated Expo Metro server, wait for usable web readiness, and print run metadata JSON.
- `doctor --run-id <id>` — run read-only checks on Metro process, port ownership, `/status`, `/`, git HEAD, evidence dir, and (when open) headless Chrome CDP health.
- `save-evidence --run-id <id> --feature <slug> --step <name> [--screenshot <path>] [--snapshot-file <path>] [--entry-point <text>] [--note <text>]` — archive surviving PNG, ARIA text, and metadata JSON under `/tmp/zappd-verify/evidence/<run-id>/<feature>/`.
- `browser-open --run-id <id> [--path /] [--width 1280] [--height 800]` — launch an isolated headless Chrome CDP session against the run's Metro URL and wait for React hydration.
- `browser-act --run-id <id> --action <click|type|press|resize> [--role <r>] [--name <n>] [--text <t>] [--clear] [--key <k>] [--modifiers <csv>] [--width <w>] [--height <h>]` — drive real mouse/keyboard/resize input via CDP and return read-only diagnostics.
- `browser-snapshot --run-id <id> [--feature <slug> --step <name> --entry-point <text> --note <text>]` — capture ARIA tree, PNG screenshot, and console/page error diagnostics, optionally saving directly to `/tmp/zappd-verify/evidence/<run-id>/<feature>/`.
- `browser-close --run-id <id>` — stop the verified headless Chrome session and remove its temporary profile.
- `cleanup --run-id <id>` — stop verified Chrome + Expo Metro processes, wait for port close, remove scratch state in `/tmp/zappd-verify/runs/<run-id>/`, and report surviving evidence file count.
- `list` — list recorded verification runs and live status.
