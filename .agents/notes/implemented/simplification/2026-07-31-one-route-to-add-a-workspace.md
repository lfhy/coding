# Agent Note: One route to add a Workspace

Status: implemented

English | [中文](2026-07-31-one-route-to-add-a-workspace.zh.md)

## Problem

Both Workspace surfaces — the sidebar region header's `+` and the conversation hero's chip — offered two ways to get a Workspace: **Open local folder…**, which raised the composed directory flow, and **Create a new workspace**, which took a name and created `<workspaceRoot>/<name>`. The two overlapped: the browse occupant carries its own **New folder** affordance, so picking a directory already covered creating one. Two entries meant two vocabularies for one outcome, a name dialog with its own duplicate-name rule, and a create target the operator could neither see nor choose.

Removing the weaker entry leaves the sidebar header with exactly one action, which raised the presentation question this decision also settles: what a popover with a single row should look like.

## Decision

Adding a Workspace has one route: pick a host directory through the composed directory flow, new or existing. `menu.addWorkspace` ("添加工作区…" / "Add workspace…") is the entry; the create-by-name dialog and its `create.*` / `menu.createWorkspace` / `workspace.new` strings are gone. The label names the outcome, not the mechanism, because it is now the only door to that outcome — a user looking for "新建" must find it.

**A menu exists to disambiguate between targets.** On the add-only sidebar surface, the add action is the only target, so the anchor gesture *is* that action: the directory flow opens directly and no one-row popover renders. The Hero is a broader start menu: it retains registered Workspaces alongside the folder, remote, and no-project actions, so an empty Workspace list never opens the directory flow automatically. The [local, remote, and no-project entry decision](../feature/2026-08-25-workspace-picker-local-remote-and-no-project-entry.md) owns those Hero actions.

Two boundaries fall out of that rule and are part of it:

- **An empty list is only final once the baseline lands.** While `phase` is `pending` the Hero keeps its menu and loading status instead of jumping into a flow that the arriving Workspaces would have made unnecessary. Once the baseline lands, its other start actions still keep the menu useful. The add-only surface lists nothing and never waits.
- **An unoccupied directory-flow hole leaves nothing to add with.** The sidebar header then renders no button at all rather than a dead one. The Hero omits its folder action but keeps any registered Workspaces, remote navigation, and no-project creation; an absent directory-flow occupant cannot withdraw those independent paths.

The add-only direct-open path carries the busy rule its menu entry states: while a pick is still being adopted (`flowBusy`), the sidebar anchor gesture is held exactly as the entry is disabled, so a late outcome cannot race a second flow.

`WorkspaceCreateFlow` is now `WorkspacePickFlow` and its `createOnly` prop is `addOnly`; the injected `createWorkspace` narrows from `{ name } | { path }` to `{ path }`.

## Wire and CLI surface

`workspace.create` accepts only `{ path }`; the wire schema and `WorkspaceApi` have no `name` member. The gateway has no `workspaceRoot` config, the client contract exposes only path adoption through `WorkspaceCreateInput`, `WorkspaceRuntime.create`, and `intentName`, and `dsh web` has no `--workspace-root` flag. `workspace-name-conflict` remains on the wire as `workspace.rename`'s duplicate-title error.

## Testing

`connectFreshWorkspace` — the helper every web e2e scenario boots through — stages `<root>/workspace` and adopts it through the dialog's path editor, so the produced session cwd stays identical to what create-by-name produced and scenario goldens stay valid. Staging rather than creating in-dialog keeps the helper idempotent across the repeated connects a scenario may make (a second create of the same folder fails, and the create dialog holds the flow open on that failure). Creating a folder from inside the chooser — the other half of the same route — is covered by `workspace-management.e2e.ts`, which owns the focused coverage: two workspaces added on folders the dialog creates, distinct same-basename directories adopted independently, a deleted title reused on a different directory, and the browser-dialog aria golden.

`smoke-real.e2e.ts` is the one scenario booting the unpatched shipped tree, where the `-auto` row resolves per host; it now pins `-browse` through a `--config` overlay so the developer's display environment cannot decide whether the picker is drivable at all.

## Alternatives considered

**Keep `Open local folder…` as the label.** Rejected: after the merge the entry both opens and creates, and naming it after the mechanism hides the creation half from exactly the users whose entry we removed. The counter-argument — "本地" usefully disambiguates the browser's machine from the harness's — is answered one step later by the dialog's own title and breadcrumbs.

**Keep the two-entry menu and make `Create a new workspace` open the same flow.** Rejected: two labels for one action is the confusion this change removes, not a smaller version of it.

**Keep a one-row popover on the add-only sidebar for consistency with the Hero.** Rejected: a popover that offers no choice is a wasted click and reads as unfinished. The Hero is a complete start menu; the sidebar's focused local action does not need to imitate it.

**Keep an empty add-only sidebar menu for future actions (clone a repo, remote directory).** Rejected under "require a current owner and need": no such sidebar action exists, and restoring a menu when one arrives is a smaller change than shipping an empty frame now.

**Delete the wire's create-by-name branch in the same change.** Rejected because the UI decision did not depend on the backend and CLI deletion, whose separate contracts and tests formed an independently reviewable change.

**Register the workspace through the host in the e2e scaffold instead of driving the dialog.** Rejected: it would have decoupled all 15 scenarios from the picker, so nothing in the lane would prove the surviving route reaches a live composer. Every scenario now walks the real dialog to adopt its directory; only the create-a-folder half is concentrated in one scenario, because repeating it everywhere makes the shared helper non-idempotent for no extra signal.

## Consequences

- The UI creates Workspace folders only under a directory the operator chooses. No server-controlled configuration constrains that location; a deployment that needs such a constraint must add it deliberately.
- The picker's configured reach defines the host filesystem available to the remaining route; there is no separate configured parent.
- A composition that mounts `ui-workspace` without a directory-picker package cannot add a Workspace and omits the button.
- The Hero chip announces `aria-haspopup="menu"` truthfully because it always opens the complete start menu. The direct local-folder action remains confined to the add-only sidebar button, which makes no popup claim.
