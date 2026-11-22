# Native canvas

Native canvas renders the universal `@expo/ui` prompt composer (`CanvasView.tsx`) on iOS Simulator and Android Emulator with keyboard avoidance and tap-outside dismissal.

## Sub-features

- `native-launch` opens Zappd on a booted simulator or emulator displaying `Prompt input` and `Send`.
- `native-input-and-submit` accepts text in `Prompt input`, submits via `Send` or keyboard return, and clears the native input.
- `native-keyboard-dismiss` dismisses the on-screen keyboard when tapping the empty canvas above the composer.

## How to get to it (user POV)

- Open the Zappd development build on an iOS Simulator or Android Emulator.
- Tap `Prompt input`, type a prompt, and tap `Send` (or keyboard `send`).
- Tap the empty canvas above the composer to dismiss the keyboard.

## Driving it with T3 Device and agent-device

Preconditions:

- Zappd Metro server is running (`zappd-verify.mjs launch` + `doctor --run-id <run-id>` exits `0`).
- `ios/` and `android/` native development builds have been generated and installed on the target simulator/emulator (`pnpm exec expo run:ios` or `pnpm exec expo run:android`). Expo Go cannot run `@expo/ui`.
- T3 `device_list` shows an available iOS Simulator or Android Emulator on `hostId: "local"`.

- **Select and open device.** Call `device_list`, pick a target `deviceId` and `hostId`, and call `device_open(hostId, deviceId)`. T3 returns the bound `agent-device` CLI invocation and shows the device in the Device panel.
- **Launch Zappd.** Run the returned `agent-device` CLI `open zappd` (pointing at the Metro dev server on `127.0.0.1:<port>`), then call `device_screenshot(hostId, deviceId)`. Zappd renders the light `#F7F7F5` canvas with the bottom pill composer.
- **Enter and dismiss keyboard.** Tap `Prompt input` via `agent-device`, enter `"Inspect camera drone"`, then tap the upper canvas area (`dismissArea`) and call `device_screenshot`. The keyboard dismisses while `"Inspect camera drone"` stays in the input.
- **Submit prompt.** Tap `Send` (`accessibilityLabel="Send"`) via `agent-device`, then call `device_screenshot`. `Prompt input` clears to `""` (`textState.set('')` and `textInput?.clear()`).
- **Proof and cleanup.** Archive screenshots via `zappd-verify.mjs save-evidence --run-id <run-id> --feature native-canvas --step <step> --screenshot <path>`, then call `device_close(hostId, deviceId)` before `zappd-verify.mjs cleanup --run-id <run-id>`.

## Gotchas

- `ios/` and `android/` are absent in a clean checkout (Continuous Native Generation per `AGENTS.md` and `.gitignore`) and `@expo/ui` requires a native development build; if no dev build is installed, mark `native-canvas` `verified-unreachable` citing the missing native dev build and never downgrade to Expo Go or weaken the check.
- Never use `xcrun simctl`, `idb`, or `adb` directly to tap, type, open apps, or take screenshots; always use `device_open`, the bound `agent-device` CLI, and `device_screenshot`.
- `CanvasView.tsx` clears the native `TextInput` imperatively (`textState.set('')` and `textInput?.clear()`); verify visually via `device_screenshot` that the input text clears after tapping `Send`.
