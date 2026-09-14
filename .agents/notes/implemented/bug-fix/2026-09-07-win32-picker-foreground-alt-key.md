# Agent Note: Foreground activation for the Win32 picker via a synthesized Alt press

Status: implemented

English | [中文](2026-09-07-win32-picker-foreground-alt-key.zh.md)

## Problem

The native Win32 folder dialog runs in a child process. When a background host starts that process, Windows can open its first window behind the foreground application, leaving the directory picker invisible to the operator.

## Decision

`runFolderDialog` calls `pressAltForForeground` between the `showing` notice and the blocking `Show`. The koffi bindings synthesize one Alt press with `keybd_event` (`VK_MENU`, down then up). Windows treats the child as a recent input owner, allowing `Show` to activate the dialog as foreground. The call runs for every Windows picker invocation; it is inert when the child already has foreground rights, though the focused window can briefly highlight its menu bar.

## Alternatives considered

**A browser-originated foreground grant.** A custom protocol or `AllowSetForegroundWindow` would require the foreground browser to participate and adds cross-process or registry state to a local picker interaction.

**AttachThreadInput.** Attaching the dialog thread to the focused thread depends on another process's thread and integrity level, so it does not provide a dependable picker contract.

## Consequences

The picker retains one spawned-child design and uses two extra user32 calls immediately before `Show`. The bindings and sequencing tests pin the Alt down/up pair and its order after the abort notice. Secure desktops, restricted Remote-SSH sessions, and an elevated foreground window can suppress injected input; the native picker may then still open behind other windows, as recorded in the package README. The browse backend remains the composition-level fallback for environments where a host-local dialog is unsuitable.
