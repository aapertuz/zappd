# Native canvas

Native canvas renders the universal `@expo/ui` prompt composer (`CanvasView.tsx`) on iOS Simulator and Android Emulator with keyboard avoidance, pre-submit tap-outside keyboard dismissal, and a post-submit `AssemblyExplorerView` mounting a 2D React Native fallback `AssemblyScene` (or an error view with `ProviderSwitcher`).

## Sub-features

- `native-launch` opens Zappd on a booted simulator or emulator displaying the `#F7F7F5` empty upper canvas, `Prompt input`, and muted yellow `Send` button.
- `native-keyboard-dismiss` dismisses the on-screen keyboard when tapping the empty upper canvas above the composer before the first submission.
- `native-input-and-submit` accepts text in `Prompt input`, ignores empty taps on `Send`, submits non-empty text via `Send`, clears the native input imperatively, and mounts `AssemblyExplorerView` in the upper surface.

## How to get to it (user POV)

- Open the Zappd development build on an iOS Simulator or Android Emulator.
- Tap `Prompt input`, type a prompt, and tap the empty upper canvas above the composer to dismiss the keyboard before submitting.
- Tap `Send` to submit the prompt and inspect the upper `AssemblyExplorerView` surface.

## Driving it with T3 Device and agent-device

Preconditions:

- Zappd Metro server is running (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs launch` and `doctor --run-id <run-id>` exit `0`).
- `ios/` and `android/` native development builds have been generated and installed on the target simulator or emulator (`pnpm exec expo run:ios` or `pnpm exec expo run:android`). `app.json` currently lacks `ios.bundleIdentifier` and `android.package`, so they must be configured before building. Expo Go cannot run `@expo/ui`.
- On Android Emulator, forward the ephemeral Metro port (`adb reverse tcp:<port> tcp:<port>`) before opening the dev build so the emulator can reach host `127.0.0.1:<port>`.
- T3 `device_list` reports an available iOS Simulator or Android Emulator with its `hostId` and `deviceId`.

- **Select and open device.** Call `device_list`, pick an available `hostId` and `deviceId`, and call `device_open(hostId, deviceId)`. T3 returns the bound `agent-device` CLI invocation and opens the device in the Device panel.
- **Launch Zappd against the isolated Metro port.** Run the returned `agent-device` CLI to open the installed Zappd dev build pointed at `http://127.0.0.1:<port>`, then call `device_screenshot(hostId, deviceId)`. Zappd renders the `#F7F7F5` empty upper canvas with the bottom pill composer and muted `Send` icon.
- **Verify pre-submit keyboard dismissal.** Tap `Prompt input` via `agent-device`, enter `"Inspect camera drone"`, capture `device_screenshot`, then tap the empty upper canvas area above the composer (must happen before the first submit) and call `device_screenshot`. The keyboard dismisses while `"Inspect camera drone"` stays in `Prompt input`.
- **Submit prompt and inspect upper surface.** Tap the `Send` button (`accessibilityLabel="Send"`) via `agent-device`, then call `device_screenshot`. `Prompt input` clears to `""` (`textState.set('')` and `textInput?.clear()`) and the upper surface mounts `AssemblyExplorerView` (either the native 2D fallback `AssemblyScene` with `Collapse`, `Explode 100%`, `Isolate`/`Show All`, and a part list, or the error text plus `ProviderSwitcher`).
- **Proof and cleanup.** Archive each screenshot with `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs save-evidence --run-id <run-id> --feature native-canvas --step <step> --screenshot <path> --entry-point "<user entry point>" --note "<observed state>"`, then call `device_close(hostId, deviceId)` before `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs cleanup --run-id <run-id>`.

## Gotchas

- `ios/` and `android/` are absent in a clean checkout (Continuous Native Generation per `AGENTS.md` and `.gitignore`) and `@expo/ui` requires a native development build. If no dev build is installed, mark `native-canvas` `verified-unreachable` citing the missing native dev build and never downgrade to Expo Go or weaken the check.
- `assemblyRuntimeService.ts` currently calls relative `fetch('/api/orchestrate')` and relative GLB URLs (`/assemblies/<archetypeId>/model.glb`), which fail in React Native because native `fetch` has no base origin. Expect native submit to land on `AssemblyExplorerView`'s error plus `ProviderSwitcher` state until native origin resolution is implemented, and record that failure as a product gap rather than masking it.
- Tap-outside keyboard dismissal (`<Pressable style={styles.dismissArea}>`) only exists while `surfaceContent` is `null`. After the first prompt submission, `CanvasView.tsx` replaces it with a plain `<View>`, and `dismissArea` is only a `StyleSheet` key rather than a `testID` or `accessibilityLabel`.
- `CanvasView.tsx` sets `accessibilityLabel="Send"` on both the outer `Host` button and inner `Icon`, omits `accessibilityState={{ disabled: !canSubmit }}`, and pairs `multiline` with `returnKeyType="send"`. Tap the outer `Send` button rather than relying on the soft keyboard return key.
- Native `AssemblyScene.ios.tsx` and `AssemblyScene.android.tsx` are currently 2D React Native fallback views (`Collapse`, `Explode 100%`, `Isolate`, flat part list) rather than RealityKit or Filament 3D views.
- Never use `xcrun simctl`, `idb`, or `adb` directly to tap, type, open apps, or take screenshots. Always use `device_open`, the bound `agent-device` CLI, and `device_screenshot`.
