# Agent Note: macOS menu bar keeps the Coding desktop session recoverable

Status: implemented

English | [中文](2026-08-24-macos-menu-bar-resident-desktop.zh.md)

## Problem

Coding's macOS window used the normal close path, which ended the desktop process even when the user only wanted the interface out of the way. A hidden desktop session needs an always-available, explicit way to restore the existing window or end the application.

## Decision

[`apps/desktop/main.go`](../../../../apps/desktop/main.go) enables `HideWindowOnClose` on macOS and labels the Cmd+W File action “隐藏窗口”. [`apps/desktop/tray_darwin.m`](../../../../apps/desktop/tray_darwin.m) creates one Cocoa `NSStatusItem` from the application icon. Its menu shows or hides Coding and provides the explicit “退出 Coding” action; the quit action routes through `NSApplication` so Wails still owns shutdown.

The same native show helper removes application hiding, restores a minimized window, and brings the Wails primary window forward. The status item and both single-instance paths share it, so a second launch recovers a hidden session. The app starts its `instance.Listener` before Wails and waits for `OnStartup` to publish the native window before handling an activation request. [`apps/desktop/tray_other.go`](../../../../apps/desktop/tray_other.go) leaves platforms without this native status item on their normal close-to-quit behavior.

The tray remains a desktop-shell concern. The loopback Host and Web client do not receive a tray binding or a platform-specific state model. [Desktop title gestures and client safe areas](../bug-fix/2026-08-24-desktop-window-chrome-safe-area.md) remain a separate window-chrome decision.

## Alternatives considered

- **Use Wails `TrayMenu`.** Rejected: the pinned Wails version defines tray menu data but does not expose an application-level creation entry, so the shell could not create a status item through that API.
- **Keep closing as quit and rely on another launch.** Rejected: it tears down the visible desktop session and does not offer a persistent menu-bar control for an intentional temporary hide.
- **Make every desktop platform hide on close immediately.** Rejected: only macOS has a native recovery item in this shell; other platforms retain their established close-to-quit behavior until their own tray implementation exists.

## Consequences

On macOS, the red close control and Cmd+W hide Coding while its menu-bar icon remains available. “显示 Coding” restores and focuses the existing window, while “退出 Coding” ends the desktop process. Windows and other non-macOS builds still close normally rather than hiding without a recovery affordance.

## Testing

`CGO_ENABLED=1 go test ./...` compiles the Cocoa bridge and verifies the custom single-instance activation delivery. A packaged `Coding.app` is checked manually for close-to-menu-bar, show, hide, quit, and second-launch restoration.
