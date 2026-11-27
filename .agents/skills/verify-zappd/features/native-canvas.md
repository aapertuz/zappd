# Native canvas

Native canvas renders the seven-card catalog (`AssemblySelectorView.tsx`) with static CAD previews and the dark-themed universal `@expo/ui` prompt composer (`CanvasView.tsx`) with keyboard avoidance, inline unsupported-edit notices, and the shared 2D React Native `NativeAssemblyScene` on iOS Simulator and Android Emulator.

## Sub-features

- `native-launch` shows the seven-card assembly catalog (`Aero X4`, `Kinetix 5`, `Nova II`, `Strider Q4`, `Helix Config`, `Reachy Mini`, `Poppy Mark I`) with static `expo-image` previews, a 2-column layout at `width >= 720`, and the `Source Inspection` badge on `Poppy Mark I`.
- `native-open-assembly` opens an assembly route (`/assemblies/<archetypeId>`) with the `Back to assemblies` button (`← Assemblies`), `NativeAssemblyScene` controls (`Collapse`, `Explode 100%`, `Isolate`/`Show All`, conditional `Shell` toggle, `Unverified assembly warning` on Poppy Mark I, `AssemblyParameters` steppers on Helix Config, part rows, and `LearningCallouts`), and the dark `@expo/ui` prompt composer.
- `native-input-and-submit` accepts text in `Prompt input`, clears the draft on submission, displays an inline `accessibilityRole="alert"` composer notice with `Dismiss notice` on unsupported edits, and loads replacements or learning answers in the upper `AssemblyExplorerView`.

## How to get to it (user POV)

- Open the Zappd development build on an iOS Simulator or Android Emulator.
- Tap a catalog card (for example `Aero X4`) to open `/assemblies/<archetypeId>`.
- Type a prompt in `Prompt input` and tap `Send`, or interact with scene controls and `Back to assemblies`.

## Driving it with T3 Device and agent-device

Preconditions:

- Zappd Metro server is running (`./.agents/skills/verify-zappd/scripts/zappd-verify.mjs launch` and `doctor --run-id <run-id>` exit `0`, yielding `<port>`).
- `ios/` and `android/` native development builds have been generated and installed on the target simulator or emulator (`pnpm exec expo run:ios --port <port>` or `pnpm exec expo run:android --port <port>`, or with `expo-dev-client` added). `app.json` currently lacks `ios.bundleIdentifier` and `android.package`, and `package.json` does not include `expo-dev-client`, so those must be configured before building. Expo Go cannot run `@expo/ui`.
- On Android Emulator, forward the ephemeral Metro port (`adb reverse tcp:<port> tcp:<port>`) before opening the dev build so the emulator can reach host `127.0.0.1:<port>`.
- T3 `device_list` reports an available iOS Simulator or Android Emulator with its `hostId` and `deviceId`.

- **Select and open device.** Call `device_list`, pick an available `hostId` and `deviceId`, and call `device_open(hostId, deviceId)`. T3 returns the bound `agent-device` CLI invocation and opens the device in the Device panel.
- **Launch Zappd against the isolated Metro port.** Use the bound `agent-device` command to open the installed Zappd development build. Capture `device_screenshot` and inspect the `"Assembly catalog"` grid, static previews, and the `Source Inspection` badge on `Poppy Mark I`.
- **Open Aero X4.** Tap the Aero X4 card (`accessibilityLabel` `"Aero X4, Quadcopter Drone CAD Assembly, 42 parts"`), wait for the initial `"Loading CAD assembly…"` text and `"Loading CAD assembly"` `progressbar` to finish, then capture `device_screenshot` confirming `"Back to assemblies"` (`← Assemblies`), `NativeAssemblyScene` (`Collapse`, `Explode 100%`, `Isolate`, clickable part rows, `LearningCallouts`), and the dark `@expo/ui` composer.
- **Verify composer notice and prompt submission.** Tap `Prompt input`, type an unsupported edit (such as `"Make the arms longer"`), and tap the outer `Send` button (`accessibilityLabel="Send"`). Confirm `Prompt input` clears (`textState.set('')` and `textInput?.clear()`) and the composer notice (`accessibilityRole="alert"`) plus `Dismiss notice` button appear; tap `Dismiss notice`. Next type `"Build an open source rover"`, tap the outer `Send` button, wait for the top overlay `progressbar` (`accessibilityLabel="Loading CAD assembly"`, no loading text on replacement) to settle, and call `device_screenshot`. Confirm `Nova II` mounts (including its conditional `Shell` / `Shell x-ray` / `Shell off` toggle) or the error `alert` plus `ProviderSwitcher` if orchestration fails. On `Helix Config`, verify `Assembly parameters` steppers (`Decrease`/`Increase` + `Apply parameters`); on `Poppy Mark I`, verify `Unverified assembly warning`.
- **Proof and cleanup.** Archive each screenshot with `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs save-evidence --run-id <run-id> --feature native-canvas --step <step> --screenshot <path> --entry-point "<user entry point>" --note "<observed state>"`, then call `device_close(hostId, deviceId)` before `./.agents/skills/verify-zappd/scripts/zappd-verify.mjs cleanup --run-id <run-id>`.

## Gotchas

- `ios/` and `android/` are absent in a clean checkout (Continuous Native Generation per `AGENTS.md` and `.gitignore`), `app.json` omits `ios.bundleIdentifier` and `android.package`, `package.json` omits `expo-dev-client`, and `@expo/ui` requires a native development build. If no dev build is installed, mark `native-canvas` `verified-unreachable` citing the missing native dev build and never downgrade to Expo Go or weaken the check.
- Expo Router infers the origin for relative API and asset requests from Metro in development. Configure a production Expo Router `origin` or a linked production server for a release build.
- `CanvasView.tsx` sets `accessibilityLabel="Send"` on both the outer `Host` button and inner `Icon`, omits `accessibilityState={{ disabled: !canSubmit }}`, and pairs `multiline` with `returnKeyType="send"`. Tap the outer `Send` button rather than relying on the soft keyboard return key.
- `AssemblyScene.ios.tsx` and `AssemblyScene.android.tsx` re-export `NativeAssemblyScene.tsx` (a 2D React Native fallback rather than RealityKit or Filament 3D views). Its `Collapse`, `Explode 100%`, and `Isolate`/`Show All` pressables omit `accessibilityRole="button"`, `Isolate` is a no-op until a part is focused, and its header and `Focused component` text use dark `#18181b` / `#52525b` colors on the unstyled container over the `#08080B` dark canvas.
- Never use `xcrun simctl`, `idb`, or `adb` directly to tap, type, open apps, or take screenshots. Always use `device_open`, the bound `agent-device` CLI, and `device_screenshot`.
