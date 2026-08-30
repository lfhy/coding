# Agent Note: Workspace picker offers local, remote, and no-project starts

Status: implemented

English | [中文](2026-08-25-workspace-picker-local-remote-and-no-project-entry.zh.md)

## Problem

The Hero Workspace picker made selecting a registered local Workspace the only durable way to start typing. A user who wanted to add a folder, open an already reachable Host, or work at the Host default directory had to discover a separate route or could not start from the same primary control.

## Decision

`WorkspacePicker` renders a searchable list of registered Workspaces and keeps three pinned Hero actions. **Open folder** delegates only to the existing directory-flow slot, so the same native or in-app picker still owns local path selection. **Connect Remote-SSH** is owned by the [bounded desktop tool-gateway decision](2026-08-30-desktop-remote-ssh-tool-gateway.md), which supersedes this record's original address-navigation arm without changing the three-action layout.

**Work without a project** calls `IWorkspaces.startSessionWithoutWorkspace()`. `WorkspaceRuntime` creates `session.create({})` through `SessionRuntime.createUnscoped()` and opens the returned, list-addressable Session. The Host supplies its normal default cwd; the absent `workspaceId` keeps that Session out of every Workspace account. Once that Session exists, the resident composer is editable even though its Hero chip reports the no-project state.

The sidebar's add-only button remains local-folder-only. It neither exposes remote navigation nor creates ungrouped Sessions, because it is a shortcut for adding a Workspace rather than the Hero's complete start menu. The [no-session composer entry](2026-08-07-workspace-picker-composer-entry.md), [one route to add a Workspace](../simplification/2026-07-31-one-route-to-add-a-workspace.md), [Workspace product flow](2026-07-25-workspace-ui-product-flow.md), [directory-picker capability seam](../architecture/2026-07-28-directory-picker-capability-seam.md), and [adaptive directory-picker default](2026-07-29-directory-picker-adaptive-default.md) retain their respective ownership rules.

## Alternatives considered

- **Use address navigation as the remote action.** Superseded by the [desktop Remote-SSH decision](2026-08-30-desktop-remote-ssh-tool-gateway.md), which records the current transport, credential, Workspace-marker, and failure boundaries.
- **Keep a no-Workspace view locked.** Rejected: a Session with the Host default cwd is already a concrete, safe working context; withholding input after it exists conflates registration with a working directory.
- **Put every start action in the sidebar.** Rejected: the sidebar control's established meaning is local Workspace adoption, and adding page navigation or Session creation there would weaken that focused action.

## Consequences

The primary picker presents all three start paths without making local directory selection less composable. The desktop-only remote path creates a bounded Remote-SSH Workspace; ordinary browser deployments report that the capability is unavailable. No-project Sessions are visible as ungrouped and run at the Host default cwd; they are not a filesystem-less or persistence-free mode.

## Verification

Component tests cover search, the three Hero actions, Remote-SSH capability absence, and no-project creation failure. Runtime tests pin the unscoped `session.create({})` call and immediate selection; the Remote-SSH record owns its bridge, validation, and lifecycle evidence.
