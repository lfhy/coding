# Agent Note: An in-process macOS folder panel behind the picker's osascript tier

Status: implemented

English | [中文](2026-09-22-macos-picker-in-process-panel.zh.md)

## Problem

The macOS tier asked `osascript` for the AppleScript `choose folder` dialog. A bundle-less `osascript` process presents that panel itself, and when the host runs as a background child of the desktop shell the panel window is created but never ordered onto a display: a window-list probe during a failing pick shows the chooser window attributed to the responsible application with `kCGWindowIsOnscreen` false, so no click can complete the modal loop. The caller waits out the AppleEvent timeout and the pick fails with `-1712` (`AppleEvent timed out`), which the GUI reports as a retryable directory-picker error.

## Decision

The darwin branch runs `osascript -l JavaScript` with a JXA script that builds an `NSOpenPanel` in process: directories choosable with files and multi-selection off, the `Select Workspace Directory` message, the `accessory` activation policy plus `activateIgnoringOtherApps`, then `runModal`. The panel takes the session's ordinary AppKit presentation path, so it reaches the screen; the probe shows a floating, on-screen panel where the AppleScript form stayed hidden. The panel still takes no interaction from the desktop-shell host: the requesting process cannot activate the application that owns it, so the operator sees a folder dialog they cannot click. The shipped web composition therefore mounts the in-page browse dialog ([in-page dialog note](../feature/2026-09-22-in-page-directory-dialog.md)), and this tier stays an overlay choice. The script returns the chosen path, or an empty string whenever `runModal` answers anything other than `NSModalResponseOK`, which `outputPath` folds into `null` cancellation.

The tier stays single and fallback-free: a JXA or osascript failure surfaces with the process's own exit code and stderr, and the caller's abort still kills the process.

## Alternatives considered

**Keep `choose folder` and widen the AppleScript timeout (`with timeout of N seconds`).** Rejected: the panel never reaches a display, so a longer AppleScript timeout only delays the same failure.

**Activate the responsible application around the AppleScript command.** Rejected: the failure is not focus ordering alone — the panel window is never ordered on screen — and the usual lever (`tell application "System Events"`) adds an Automation consent prompt to a local folder pick.

**Present the folder panel from the desktop shell through a Wails binding.** Rejected: `host.pickDirectory` also serves the browser and CLI carriers, so a shell-only route leaves the native tier broken outside the desktop shell and adds a second picker path beside the seam's one backend.

## Consequences

- The darwin branch loses its `-128`/`User canceled` stderr heuristic: cancellation is an empty result, and every command failure surfaces as-is.
- `tests/native-picker.spec.ts` pins the JXA argv and the empty-output cancellation; the malformed-error cases now run against the Linux tier, which still classifies cancellation by exit code.
- Reintroduction condition: a system folder chooser that presents itself from background processes would remove the reason for the JXA bridge; until then `choose folder` stays out.
