# Native canvas

Native canvas renders the dark-themed universal `@expo/ui` prompt composer (`CanvasView.tsx`) on iOS Simulator and Android Emulator with keyboard avoidance, pre-submit tap-outside keyboard dismissal, and a post-submit `AssemblyExplorerView` mounting a loading bar, error card with `ProviderSwitcher`, or the shared 2D React Native `NativeAssemblyScene` (re-exported by `AssemblyScene.ios.tsx` and `AssemblyScene.android.tsx`) with native `LearningCallouts`.

## Sub-features

- `native-launch` opens Zappd on a booted simulator or emulator displaying the `#08080B` dark empty upper canvas, dark `@expo/ui` pill composer with `Prompt input` (`"Describe a CAD assembly to explore..."`), and circular `#F5C451` `Send` button whose inner icon switches from muted `#8B816E` to `#141008` when `canSubmit` is true.
- `native-keyboard-dismiss` dismisses the on-screen keyboard when tapping the empty upper canvas above the composer before the first submission.
- `native-input-and-submit` accepts text in `Prompt input`, ignores empty taps on `Send`, submits non-empty text via `Send`, clears the native input imperatively, displays `"Loading verified CAD assembly…"` with a `progressbar`, and mounts `AssemblyExplorerView` (error plus `ProviderSwitcher`, or `NativeAssemblyScene` with `Collapse`, `Explode 100%`, `Isolate`/`Show All`, clickable part rows that enter part focus with `Back` and `Focused component`, and native `LearningCallouts` cards with `Dismiss answer`).

## How to get to it (user POV)

- Open the Zappd development build on an iOS Simulator or Android Emulator.
- Tap `Prompt input`, type a prompt, and tap the empty upper canvas above the composer to dismiss the keyboard before submitting.
- Tap `Send` to submit the prompt and inspect the upper `AssemblyExplorerView` view.

## Driving it with T3 Device and agent-device

Preconditions:

- Zappd Metro server is running (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs launch` and `doctor --run-id <run-id>` exit `0`, yielding `<port>`).
- `ios/` and `android/` native development builds have been generated and installed on the target simulator or emulator (`pnpm exec expo run:ios --port <port>` or `pnpm exec expo run:android --port <port>`, or with `expo-dev-client` added). `app.json` currently lacks `ios.bundleIdentifier` and `android.package`, and `package.json` does not include `expo-dev-client`, so those must be configured before building. Expo Go cannot run `@expo/ui`.
- On Android Emulator, forward the ephemeral Metro port (`adb reverse tcp:<port> tcp:<port>`) before opening the dev build so the emulator can reach host `127.0.0.1:<port>`.
- T3 `device_list` reports an available iOS Simulator or Android Emulator with its `hostId` and `deviceId`.

- **Select and open device.** Call `device_list`, pick an available `hostId` and `deviceId`, and call `device_open(hostId, deviceId)`. T3 returns the bound `agent-device` CLI invocation and opens the device in the Device panel.
- **Launch Zappd against the isolated Metro port.** Run the returned `agent-device` CLI to open the installed Zappd dev build, then call `device_screenshot(hostId, deviceId)` and visually inspect the PNG. Zappd renders the dark `#08080B` empty upper canvas with the bottom dark pill composer (`#12110E`), `"Describe a CAD assembly to explore..."` placeholder, and `#F5C451` `Send` button with muted `#8B816E` icon.
- **Verify pre-submit keyboard dismissal.** Tap `Prompt input` via `agent-device`, enter `"Inspect camera drone"`, capture `device_screenshot` (confirming the active `#141008` `Send` icon), then tap the empty upper canvas area above the composer (must happen before the first submit) and call `device_screenshot`. The keyboard dismisses while `"Inspect camera drone"` stays in `Prompt input`.
- **Submit prompt and inspect upper view.** Tap the outer `Send` button (`accessibilityLabel="Send"`) via `agent-device`, wait briefly for the transient `"Loading verified CAD assembly…"` `progressbar` to settle, and call `device_screenshot`. `Prompt input` clears to `""` (`textState.set('')` and `textInput?.clear()`) and the upper view mounts `AssemblyExplorerView` (either the error `alert` plus `ProviderSwitcher`, or `NativeAssemblyScene` with `Collapse`, `Explode 100%`, `Isolate`/`Show All`, clickable part rows revealing `Back` and `Focused component`, and native `LearningCallouts` `role="status"` cards with `Dismiss answer`).
- **Proof and cleanup.** Archive each screenshot with `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs save-evidence --run-id <run-id> --feature native-canvas --step <step> --screenshot <path> --entry-point "<user entry point>" --note "<observed state>"`, then call `device_close(hostId, deviceId)` before `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs cleanup --run-id <run-id>`.

## Gotchas

- `ios/` and `android/` are absent in a clean checkout (Continuous Native Generation per `AGENTS.md` and `.gitignore`), `app.json` omits `ios.bundleIdentifier` and `android.package`, `package.json` omits `expo-dev-client`, and `@expo/ui` requires a native development build. If no dev build is installed, mark `native-canvas` `verified-unreachable` citing the missing native dev build and never downgrade to Expo Go or weaken the check.
- `assemblyRuntimeService.ts` calls relative `fetch('/api/orchestrate')` and relative GLB URLs (`/assemblies/<archetypeId>/model.glb`), and `learningEngine.ts` calls relative `fetch('/api/learn')`. Those relative fetches fail in React Native because native `fetch` has no base origin. Expect native submit to land on `AssemblyExplorerView`'s error plus `ProviderSwitcher` state (and cloud learning to fall back to `offline_cache`) until native origin resolution is implemented, and record that failure as a product gap rather than masking it.
- Tap-outside keyboard dismissal (`<Pressable style={styles.dismissArea}>`) only exists while `surfaceContent` is `null`. After the first prompt submission, `CanvasView.tsx` replaces it with a plain `<View>`, and `dismissArea` is only a `StyleSheet` key rather than a `testID` or `accessibilityLabel`.
- `CanvasView.tsx` sets `accessibilityLabel="Send"` on both the outer `Host` button and inner `Icon`, omits `accessibilityState={{ disabled: !canSubmit }}`, and pairs `multiline` with `returnKeyType="send"`. Tap the outer `Send` button rather than relying on the soft keyboard return key.
- `AssemblyScene.ios.tsx` and `AssemblyScene.android.tsx` re-export `NativeAssemblyScene.tsx` (a 2D React Native fallback rather than RealityKit or Filament 3D views). Its `Collapse`, `Explode 100%`, and `Isolate`/`Show All` pressables omit `accessibilityRole="button"`, `Isolate` is a no-op until a part is focused, and its header text uses dark `#18181b` / `#52525b` colors on the unstyled container over the `#08080B` dark canvas.
- Never use `xcrun simctl`, `idb`, or `adb` directly to tap, type, open apps, or take screenshots. Always use `device_open`, the bound `agent-device` CLI, and `device_screenshot`.
