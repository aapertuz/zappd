# Native canvas

Native canvas renders the dark-themed universal `@expo/ui` prompt composer (`CanvasView.tsx`) on iOS Simulator and Android Emulator with keyboard avoidance inside a selected assembly. The catalog shows still CAD previews and opens the shared 2D React Native `NativeAssemblyScene` on iOS and Android.

## Sub-features

- `native-launch` shows the assembly catalog and its CAD previews.
- `native-open-assembly` opens Aero X4 with the Assemblies button and dark prompt composer.
- `native-input-and-submit` accepts text in `Prompt input`, clears the draft on submission, and displays the result in the explorer.

## How to get to it (user POV)

- Open the Zappd development build on an iOS Simulator or Android Emulator.
- Tap `Aero X4` and type in `Prompt input`.
- Tap `Send` to submit the prompt and inspect the upper `AssemblyExplorerView` view.

## Driving it with T3 Device and agent-device

Preconditions:

- Zappd Metro server is running (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs launch` and `doctor --run-id <run-id>` exit `0`, yielding `<port>`).
- `ios/` and `android/` native development builds have been generated and installed on the target simulator or emulator (`pnpm exec expo run:ios --port <port>` or `pnpm exec expo run:android --port <port>`, or with `expo-dev-client` added). `app.json` currently lacks `ios.bundleIdentifier` and `android.package`, and `package.json` does not include `expo-dev-client`, so those must be configured before building. Expo Go cannot run `@expo/ui`.
- On Android Emulator, forward the ephemeral Metro port (`adb reverse tcp:<port> tcp:<port>`) before opening the dev build so the emulator can reach host `127.0.0.1:<port>`.
- T3 `device_list` reports an available iOS Simulator or Android Emulator with its `hostId` and `deviceId`.

- **Select and open device.** Call `device_list`, pick an available `hostId` and `deviceId`, and call `device_open(hostId, deviceId)`. T3 returns the bound `agent-device` CLI invocation and opens the device in the Device panel.
- **Launch Zappd against the isolated Metro port.** Use the bound `agent-device` command to open the installed Zappd development build. Capture `device_screenshot` and inspect the catalog, including the Source Inspection badge on Poppy Mark I.
- **Open Aero X4.** Tap the card, wait for the assembly to load, then inspect the Assemblies button, scene, and composer in a screenshot. Tap `Prompt input` and type `"Build an open source rover"`.
- **Submit prompt and inspect upper view.** Tap the outer `Send` button (`accessibilityLabel="Send"`) via `agent-device`, wait briefly for the transient `"Loading CAD assembly…"` `progressbar` to settle, and call `device_screenshot`. `Prompt input` clears to `""` (`textState.set('')` and `textInput?.clear()`) and the upper view mounts `AssemblyExplorerView` (either the error `alert` plus `ProviderSwitcher`, or `NativeAssemblyScene` with `Collapse`, `Explode 100%`, `Isolate`/`Show All`, clickable part rows revealing `Back` and `Focused component`, and native `LearningCallouts` `role="status"` cards with `Dismiss answer`).
- **Proof and cleanup.** Archive each screenshot with `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs save-evidence --run-id <run-id> --feature native-canvas --step <step> --screenshot <path> --entry-point "<user entry point>" --note "<observed state>"`, then call `device_close(hostId, deviceId)` before `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs cleanup --run-id <run-id>`.

## Gotchas

- `ios/` and `android/` are absent in a clean checkout (Continuous Native Generation per `AGENTS.md` and `.gitignore`), `app.json` omits `ios.bundleIdentifier` and `android.package`, `package.json` omits `expo-dev-client`, and `@expo/ui` requires a native development build. If no dev build is installed, mark `native-canvas` `verified-unreachable` citing the missing native dev build and never downgrade to Expo Go or weaken the check.
- Expo Router infers the origin for relative API and asset requests from Metro in development. Configure a production Expo Router `origin` or a linked production server for a release build.
- `CanvasView.tsx` sets `accessibilityLabel="Send"` on both the outer `Host` button and inner `Icon`, omits `accessibilityState={{ disabled: !canSubmit }}`, and pairs `multiline` with `returnKeyType="send"`. Tap the outer `Send` button rather than relying on the soft keyboard return key.
- `AssemblyScene.ios.tsx` and `AssemblyScene.android.tsx` re-export `NativeAssemblyScene.tsx` (a 2D React Native fallback rather than RealityKit or Filament 3D views). Its `Collapse`, `Explode 100%`, and `Isolate`/`Show All` pressables omit `accessibilityRole="button"`, `Isolate` is a no-op until a part is focused, and its header text uses dark `#18181b` / `#52525b` colors on the unstyled container over the `#08080B` dark canvas.
- Never use `xcrun simctl`, `idb`, or `adb` directly to tap, type, open apps, or take screenshots. Always use `device_open`, the bound `agent-device` CLI, and `device_screenshot`.
