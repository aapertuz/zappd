---
name: verify-zappd
description: 'Verify the Zappd Expo application end-to-end as a user: launch an isolated Expo Metro web server, health-check it, drive the web canvas in Google Chrome via CDP (or native simulator/emulator builds via T3 Device and agent-device), capture surviving proof artifacts, and clean up. Reach for this whenever proving Zappd UI, composer, or platform behavior.'
---

# Verify Zappd

Zappd is an Expo SDK 58 and Expo Router application with two app routes (`src/app/index.tsx` rendering `AssemblySelectorScreen` and `src/app/assemblies/[archetypeId].tsx` rendering `CanvasScreen` or an unavailable fallback) and five API routes (`src/app/api/assemblies/[archetypeId]+api.ts`, `src/app/api/orchestrate+api.ts`, `src/app/api/rebuild+api.ts`, `src/app/api/route-prompt+api.ts`, and `src/app/api/learn+api.ts`).

- **Primary target.** Web UI served by Expo Metro on `http://127.0.0.1:<port>/` (`AssemblySelectorView.web.tsx`, `useCatalogTurntable.web.ts`, `CanvasView.web.tsx`, `AssemblyScene.web.tsx`, `AssemblyParameters.web.tsx`, and `LearningCallouts.web.tsx` using React DOM, CSS Modules, and Three.js WebGL), driven in Google Chrome via `zappd-verify.mjs`.
- **Secondary target.** Native iOS and Android UI (`AssemblySelectorView.tsx`, `CanvasView.tsx` using universal `@expo/ui`, `AssemblyParameters.tsx`, `LearningCallouts.tsx`, and the 2D fallback `NativeAssemblyScene.tsx` re-exported by `AssemblyScene.ios.tsx` and `AssemblyScene.android.tsx`). Because `ios/` and `android/` are CNG-generated and absent in a clean checkout, native verification requires a local development build (`pnpm exec expo run:ios` or `pnpm exec expo run:android`). See [`features/native-canvas.md`](features/native-canvas.md).
- **Isolation.** Each checkout shares `.expo/`, so the helper allows only one active verification server per checkout realpath and refuses to double-drive an active run. Concurrent runs in separate git worktrees work independently on distinct ephemeral ports (`18081..18999`). Never touch developer port `8081`.
- **Scratch and evidence.** Run state (`state.json`, `metro.log`, `chrome-profile/`, `chrome.log`) lives under `/tmp/zappd-verify/runs/<run-id>/` and is deleted by cleanup. Proof artifacts live under `/tmp/zappd-verify/evidence/<run-id>/<feature>/` and survive cleanup.

## Launch

Start an isolated Expo Metro server bound to `127.0.0.1` on a free port in `18081..18999`. The launcher omits `--web` and `CI=1` (keeping Fast Refresh active) and sets `EXPO_NO_TELEMETRY=1` and `BROWSER=none`.

```bash
./.agents/skills/verify-zappd/scripts/zappd-verify.mjs launch
```

- **Underlying command.** `node <expo/bin/cli> start --localhost --port <port>` in the repository root.
- **Usable readiness criteria.** `launch` waits (default `--timeout-ms 60000`) until three checks pass.
  1. `GET /status` returns `200` with body `packager-status:running` and `X-React-Native-Project-Root` matching the checkout realpath.
  2. `GET /` returns `200` (`text/html`) containing `aria-label="Assembly catalog"`, `Aero X4`, and `Quadcopter Drone CAD Assembly`.
  3. The preloaded client `entry.bundle` URL in `/` compiles and returns `200`, followed by a clean `GET /` settle check.
- **Catalog, CAD rebuilds, and AI providers.** Open any of the seven cards on `/` (`Aero X4`, `Kinetix 5`, `Nova II`, `Strider Q4`, `Helix Config`, `Reachy Mini`, `Poppy Mark I`) to navigate to `/assemblies/<archetypeId>`. The catalog turntable and explorer load geometry via `GET /api/assemblies/<archetypeId>` without an LLM API key, using local precomputed exports, Firebase Storage, or the local CAD worker. In-place parameter rebuilds (`POST /api/rebuild`) require the Python CAD worker (`backend/.venv/bin/python`) and verified STEP cache (`backend/data/open_step_cache/`). Provider keys (`DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, or `OPENAI_API_KEY`) enable cloud explanations (`/api/learn`), cloud routing escalation on low-confidence prompts (`/api/route-prompt`), and explicit provider retries on `/api/orchestrate`.
- **Output.** JSON containing `runId`, `pid`, `port`, `url`, `gitHead`, `logPath`, and `evidenceDir`. Always run `cleanup --run-id <run-id>` when done or after any failure.

## Doctor

Before driving the first feature and immediately after any unexpected failure, run the read-only health check.

```bash
./.agents/skills/verify-zappd/scripts/zappd-verify.mjs doctor --run-id <run-id>
```

It exits `0` only when all checks pass.

1. `processAlive` confirms the recorded PID is alive and its `ps` command line is `expo` on `--port <port>`.
2. `portOwner` confirms `lsof` reports the recorded PID owns `127.0.0.1:<port>`.
3. `statusEndpoint` confirms `GET /status` returns `packager-status:running` for this exact checkout realpath.
4. `rootRouteRender` confirms `GET /` returns `200` HTML with the Assembly catalog, Aero X4, and its technical title.
5. `orchestrateEndpoint` confirms `GET /api/orchestrate` returns `200` JSON and reports `configuredProviders` and `defaultProvider`.
6. `gitRevisionMatch` confirms `git rev-parse HEAD` matches the revision recorded at launch.
7. `evidenceDirExists` confirms `/tmp/zappd-verify/evidence/<run-id>/` exists.
8. `browserAlive` (present when `browser-open` is active) confirms the recorded Chrome PID owns its isolated `--user-data-dir` profile and its CDP `/json/version` endpoint returns `200`.

## Drive

Read [`features/README.md`](features/README.md) first, then follow the matching recipe under [`features/`](features/). Do not use T3 Preview (`preview_*` tools) for verification. Use Google Chrome through `zappd-verify.mjs`.

### Web driver (Google Chrome via CDP)

1. Launch an isolated headless Chrome session targeting `/` (or `/assemblies/<archetypeId>`, or `/assemblies/does_not_exist`) and wait for React hydration.
   ```bash
   ./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-open --run-id <run-id> --path / --width 1280 --height 800
   ```
2. Re-run `doctor --run-id <run-id>` so `browserAlive` is verified alongside Metro checks.
3. On the catalog, use `browser-act --action hover --role button --name "Kinetix 5"` or `--action press --key Tab` to change the live turntable. Click a card or press `Enter` or `Space` while it has focus to open the explorer. Click `button "Back to assemblies"` (or `link "Back to assemblies"` on the unavailable fallback) to return to `/`. Check `diagnostics.selector` for the active card, angle, frame count, and visible cards. Check `diagnostics.webglContexts.active` for at most one live context on the catalog and across navigation.
4. Drive DOM controls by accessible role and name (`--role textbox --name "Prompt input"`, `--role button --name "Send"`, `--role button --name "Dismiss notice"`, `--role button --name "Explode (0%)"`, `--role button --name "Wiring visibility: Auto"`, `--role button --name "Shell visibility: Solid"`, `--role button --name "Increase Rotor Count"`, `--role button --name "Apply parameters"`, `--role button --name "Back"`, `--role button --name "Dismiss answer"`), and drive 3D WebGL mesh interactions by projected `[x, y]` coordinates from `diagnostics.assembly.nodeScreenPositions` via `browser-act`.
   - `click` dispatches real mouse move, press, and release events on the control center or canvas coordinate (`--x`, `--y`).
   - `hover` dispatches a real `mouseMoved` pointer event (`pointerType: "mouse"`) on a control center or canvas coordinate (`--x`, `--y`) to trigger overview hover inspection and circuit highlights.
   - `type` focuses the target only when needed (or clears when `--clear` is set), preserving caret position after `Shift+Enter`, and inserts text via CDP `Input.insertText`.
   - `press` dispatches real `rawKeyDown`, `char`, and `keyUp` events (for example `--key Enter`, `--key Enter --modifiers Shift`, or `--key Escape`).
   - `resize` updates and persists `Emulation.setDeviceMetricsOverride` dimensions across subsequent CLI invocations.
   - Open with `--reduced-motion true` or toggle motion in an open tab with `browser-act --action emulate-motion --reduced-motion true`. On the catalog, compare two snapshots to confirm angle and frame count stay frozen. In learning checks under headless SwiftShader, `--reduced-motion true` also bypasses the `54 chars/sec` typewriter animation so settled cards render immediately.
   - Each `browser-act` waits `120 ms` plus up to two animation frames (capped at `4000 ms` to accommodate headless SwiftShader WebGL frames) so `diagnostics.assembly` reflects the rendered frame immediately.
5. Wait for asynchronous catalog loading, orchestration, GLB loading, initial assembly playback, in-place parameter rebuilds (`--manifest-hash-not <previous-hash>`), learning explanations, or visible text via `browser-wait`.
   ```bash
   ./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-wait --run-id <run-id> --archetype quadcopter_drone_v1 --settled --learning-ready explanation --timeout-ms 60000
   ```
6. Capture ARIA trees, screenshots, and read-only diagnostics (`diagnostics.promptPlaceholder`, `diagnostics.composerNotice`, `diagnostics.selector`, `diagnostics.webglContexts`, `diagnostics.assembly`, `diagnostics.learning`, `diagnostics.isLoadingAssembly`, `diagnostics.hasProviderToolbar`, `diagnostics.errors`) via `browser-snapshot`.
7. Close only the browser session with `browser-close --run-id <run-id>` if tearing down Chrome separately, or use `cleanup --run-id <run-id>` to stop both Chrome and Metro together.

### Native driver

For native iOS and Android verification, follow [`features/native-canvas.md`](features/native-canvas.md) using T3 `device_list`, `device_open`, the bound `agent-device` CLI, and `device_screenshot`. Never use raw `xcrun simctl`, `idb`, or `adb` for UI driving.

## Evidence

Store all proof artifacts under `/tmp/zappd-verify/evidence/<run-id>/<feature>/`.

- Capture Chrome web screenshots, ARIA trees, and metadata directly with `browser-snapshot`.

```bash
./.agents/skills/verify-zappd/scripts/zappd-verify.mjs browser-snapshot \
  --run-id <run-id> \
  --feature <feature-slug> \
  --step <step-name> \
  --entry-point "<user entry point>" \
  --note "<observed state and 0-error check>"
```

- Archive native screenshots (`device_screenshot`) or external proof files with `save-evidence`.

```bash
./.agents/skills/verify-zappd/scripts/zappd-verify.mjs save-evidence \
  --run-id <run-id> \
  --feature <feature-slug> \
  --step <step-name> \
  --screenshot <screenshot-png> \
  --snapshot-file <aria-snapshot-txt> \
  --entry-point "<user entry point>" \
  --note "<observed state>"
```

Proof standards apply to every verification pass.

- Drive only real user interactions (`browser-act`, keyboard events, real clicks and hovers). Never bypass controls via internal state hooks or state-mutating JS evaluation.
- Capture both the action or pre-submit state and the resulting settled state, including console and page error counts (`errors: []`).
- Verify 3D WebGL scene and interaction states through `diagnostics.assembly` (`webglActive`, `archetypeId`, `verificationStatus`, `manifestHash`, `parameterValues`, `isRebuildingParameters`, `unverifiedFailures`, `buildCacheMode`, `glbNodeCount`, `assemblyStatus`, `camera`, `explodeFactor`, `wiringVisibility`, `hasShell`, `shellVisibility`, `hoveredComponentId`, `hoveredPartCallout`, `selectedComponentId`, `isolatedComponentId`, `viewMode`, `focusedPartCallout`, `circuitHighlightIds`), `diagnostics.learning`, `diagnostics.composerNotice`, `diagnostics.selector`, `diagnostics.webglContexts`, and visual inspection of PNG screenshots. Pair live runs with `pnpm run test:unit` for reducer, hybrid-router, and domain contracts.
- Long multi-route verification sessions can exhaust Expo Metro dev SSR memory after repeated SSR reloads. If `doctor` reports `processAlive: false` or `fetch failed`, clean up that run (evidence survives) and launch a fresh run ID.
- If a precondition is unmet (such as no built native app for `native-canvas.md`, no configured AI API key for cloud responses, or missing `backend/data/open_step_cache/` for live parameter rebuilds), report the feature or sub-feature as `verified-unreachable` with the unmet precondition and never weaken the journey.

## Cleanup

Tear down only the Chrome session, Expo Metro server, and device panel created by this run.

1. If a simulator or emulator was opened for native verification, call `device_close`.
2. Stop Chrome (if open) and Expo Metro, and delete `/tmp/zappd-verify/runs/<run-id>/`.

```bash
./.agents/skills/verify-zappd/scripts/zappd-verify.mjs cleanup --run-id <run-id>
```

- `cleanup` verifies PID command-line ownership for both Chrome (`--user-data-dir=...`) and Expo (`--port ...`) before signaling `SIGTERM` (escalating to `SIGKILL` only for those verified PIDs if still alive), waits for ports to close, and never kills by process name.
- Confirm after cleanup that `/tmp/zappd-verify/runs/<run-id>/` is gone and your proof artifacts under `/tmp/zappd-verify/evidence/<run-id>/` remain intact.

## Helpers

Executable helper: [`.agents/skills/verify-zappd/scripts/zappd-verify.mjs`](scripts/zappd-verify.mjs) (with CDP module [`scripts/cdp-browser.mjs`](scripts/cdp-browser.mjs) and persistent reduced-motion worker [`scripts/cdp-motion.mjs`](scripts/cdp-motion.mjs)).

- `launch [--run-id <id>] [--port <port>] [--timeout-ms <ms>]` starts an isolated Expo Metro server, waits for usable web readiness, and prints run metadata JSON.
- `doctor --run-id <id>` runs read-only checks on Metro process, port ownership, `/status`, `/`, `/api/orchestrate`, git HEAD, evidence dir, and (when open) Google Chrome CDP health.
- `browser-open --run-id <id> [--path /] [--width 1280] [--height 800] [--reduced-motion [true|false]]` launches an isolated headless Chrome CDP session against the run's Metro URL with background-throttling disabled and waits for React hydration on catalog, explorer, or unavailable routes.
- `browser-act --run-id <id> --action <click|hover|type|press|resize|emulate-motion> [--role <r>] [--name <n>] [--x <px> --y <px>] [--text <t>] [--clear] [--key <k>] [--modifiers <csv>] [--width <w>] [--height <h>] [--reduced-motion <true|false>]` drives real mouse, hover, keyboard, motion-emulation, and resize input via CDP, waits for rendered animation frames, and returns read-only diagnostics.
- `browser-wait --run-id <id> [--archetype <id>] [--provider <id>] [--settled] [--manifest-hash-not <hash>] [--learning-ready <explanation|answer>] [--text <substring>] [--timeout-ms <ms>]` polls read-only diagnostics until the requested assembly, provider, animation and rebuild settlement, manifest-hash change, learning callout completion, text, or default post-submit settlement matches.
- `browser-snapshot --run-id <id> [--feature <slug> --step <name> --entry-point <text> --note <text>]` captures the ARIA tree, PNG screenshot, composer, selector, WebGL, 3D assembly, and learning diagnostics, and console/page error counts, optionally saving directly to `/tmp/zappd-verify/evidence/<run-id>/<feature>/`.
- `browser-close --run-id <id>` stops the verified Chrome session and removes its temporary profile.
- `save-evidence --run-id <id> --feature <slug> --step <name> [--screenshot <path>] [--snapshot-file <path>] [--entry-point <text>] [--note <text>]` archives surviving PNG, ARIA text, and metadata JSON under `/tmp/zappd-verify/evidence/<run-id>/<feature>/`.
- `cleanup --run-id <id>` stops verified Chrome and Expo Metro processes, waits for port close, removes scratch state in `/tmp/zappd-verify/runs/<run-id>/`, and reports the surviving evidence file count.
- `list` lists recorded verification runs and live status.
