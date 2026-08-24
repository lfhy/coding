# Agent Note: Desktop window chrome keeps title gestures and sidebar safe areas

Status: implemented

English | [中文](2026-08-24-desktop-window-chrome-safe-area.zh.md)

## Problem

The Coding desktop shell uses Wails `FullSizeContent`, so the WebView owns the visible top chrome while the native macOS traffic lights float over that content. The shell must retain native title-bar gestures without making the browser client depend on desktop APIs, and the sidebar footer must remain anchored when slot occupants change.

## Decision

[`apps/desktop/main.go`](../../../../apps/desktop/main.go) starts the Wails window in `options.Maximised`. Its `OnDomReady` bridge defers the drag message for non-interactive top content until the pointer moves, so a stationary double-click can send the `Wt` toggle-maximise message without being consumed by the first drag event.

The sidebar root adds `--app-safe-area-inset-top` to the collapsed rail's top padding as well as the expanded column. The footer owns an auto top margin, while the Settings trigger removes its bottom margin in both wide and rail modes; the root has no bottom inset so the trigger reaches the viewport edge.

## Alternatives considered

- **Restore the native title bar.** Rejected: the desktop shell deliberately uses full-size content and needs the WebView to provide the shared top drag surface.
- **Put a fixed desktop offset into the sidebar component.** Rejected: the same component is shipped in ordinary browsers, where the offset would create an unexplained gap; the shell-provided custom property keeps the platform difference at the boundary.
- **Absolutely position the Settings trigger.** Rejected: the footer has dynamic slot occupants, so flex layout keeps Settings at the edge without coupling the shell to a particular action set.

## Consequences

Desktop launches open maximized, and an empty top double-click toggles that state without treating buttons or form controls as title chrome. Browser builds keep the safe-area variable at its zero fallback. Rail controls clear the macOS traffic lights, and the Settings control reaches the sidebar's bottom edge while footer contributions remain composable.

## Testing

The sidebar and Settings CSS contracts are covered by focused Vitest specs. `go test ./...`, a tagged desktop production build, and the Web build pass; the rebuilt desktop Host geometry check places the Settings trigger at the viewport bottom in both wide and rail states.
