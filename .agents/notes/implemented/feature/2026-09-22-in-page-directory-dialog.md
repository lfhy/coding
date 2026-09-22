# Agent Note: The in-page directory dialog is the shipped interaction

Status: implemented

English | [中文](2026-09-22-in-page-directory-dialog.zh.md)

## Problem

The shipped web bundle mounted the adaptive [`-auto`](2026-07-29-directory-picker-adaptive-default.md) chooser, which resolves to the native OS chooser on a loopback bind under darwin/win32. The host process is always a background child — of the desktop shell or of a terminal — and an OS chooser presented from that position cannot take interaction: on macOS the AppleScript panel never reaches a display, and the in-process `NSOpenPanel` that replaced it is composited without accepting clicks ([macOS panel note](../bug-fix/2026-09-22-macos-picker-in-process-panel.md)). The desktop GUI therefore offered a folder dialog the operator could not use, carrying the panel's own English message text, and each carrier had a different interaction.

## Decision

`packages/bundle/web-app/cordis.patch.yml` mounts `@deepseek-ai/dsh-host-directory-picker-browse` as the `directory-picker` row and `@deepseek-ai/dsh-client-ui-directory-picker-browse` as a browser row, so the desktop shell, a local browser, and a remote browser all get the same in-page dialog: a modal card with breadcrumb, two-pane level walk, typed path, new-folder creation, and a hidden-file toggle, all strings from the client's `directory-browser` dictionaries (Chinese by default). `-native` and `-auto` remain packages that only an overlay composes.

The three test-side pins that forced `-browse` are gone — the web e2e scaffold's disable+insert pair, the real-host smoke overlay (`pin-browse-picker.overlay.yml`, deleted), and the CLI preset e2e's pair. The shipped composition is what those lanes need, so the smoke now spawns the real `dsh web` without an overlay.

## Alternatives considered

**Keep the adaptive default and repair the native panel's activation.** Rejected: the panel is presented by a process that is not the application, so activation is not the picker's to grant; the macOS tier already presents an in-process `NSOpenPanel` and still takes no clicks from the desktop shell.

**Add a config field selecting the interaction.** Rejected: the seam's documented swap point is composition rather than configuration (`-auto`'s README states this), and a per-deployment field would still ship one interaction for the desktop GUI.

**Keep the test pins after switching the default.** Rejected: a pin that reproduces the shipped row is duplicated configuration whose comment would have to explain that it changes nothing.

## Consequences

- Every carrier gets one interaction, and it is the one the browser e2e lane already drove (`apps/web/tests/workspace-management.e2e.ts` and 30+ specs through `connectFreshWorkspace`).
- The native tiers stay for a deployment that demonstrably reaches the host's own GUI session; their platform limitations are recorded in `packages/host/directory-picker-native/README.md`.
- `-auto` is no longer mounted by the shipped composition; its README records the opt-in status and inherits the detection limits.
- The trade is the in-page dialog's feature set: no multi-select, no recent-places memory, a 1000-row bound per level, and no OS integration.
