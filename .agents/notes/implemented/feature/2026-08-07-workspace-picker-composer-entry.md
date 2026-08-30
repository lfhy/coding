# Agent Note: The no-session composer opens the existing picker

Status: implemented

English | [中文](2026-08-07-workspace-picker-composer-entry.zh.md)

## Problem

The [session-scope decision](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md) keeps one resident composer before a Session exists, but its textarea was disabled and only the smaller Workspace chip could open the picker. The largest and most familiar starting affordance therefore rejected the user's first click even though a recovery action was available on the same surface.

## Decision

While no current Session owns the view, the whole composer card activates the existing `conversation.hero.workspace` picker by pointer click — the card owns the click handler and its disabled controls let pointer events fall through, so the full capsule is one target — and the read-only resident textarea does the same by Enter or Space. `aria-haspopup="menu"` and `aria-expanded` describe the shared picker menu while it is mounted. The picker lists and searches registered Workspaces and retains its folder flow, while [its local, remote, and no-project entry decision](2026-08-25-workspace-picker-local-remote-and-no-project-entry.md) adds three explicit start paths. A dashed l4 stroke (an SVG dash ring, since native `dashed` has a fixed pattern) with a business-blue hover marks the card as the picker affordance. The card contains `pointerdown`, so the open picker's outside-close cannot race the click's reopen — that close-then-open flickered the chip's expansion echo. Message submission, command, permission, model, and other Session-scoped controls remain locked until a Session exists, not until a Workspace is selected.

Workspace selection retains the existing owner and flow. `ConversationRoot` opens the picker, `WorkspacePicker` lists or creates the Workspace, and the same textarea DOM node becomes the editable composer after that Session arrives. Choosing **Work without a project** creates an ungrouped Session at the Host default cwd and reaches the same editable state without a Workspace registration.

## Alternatives considered

**Keep the textarea disabled and emphasize the Workspace chip.** This preserves the old control boundary but leaves the dominant composer surface inert during the first action.

**Place a transparent button over the textarea.** A button has direct trigger semantics, but it creates a second focusable element over the resident textarea and complicates the DOM-identity transition that preserves focus, IME, and draft behavior.

**Accept a draft before a Session exists.** This would require a client-owned draft Session or another pre-Session state axis. The feature only needs a discoverable path into the existing picker.

## Consequences

The first composer click now continues a clear start flow, and keyboard users can activate the same path. The textarea accurately reports read-only state until a Session exists, while adjacent controls remain disabled. The UI introduces no pre-Session draft state; its picker may choose a Workspace, create an ungrouped Session, or start the desktop-only [Remote-SSH Workspace flow](2026-08-30-desktop-remote-ssh-tool-gateway.md).

Component coverage pins pointer and keyboard activation, the card-wide click target, the contained `pointerdown`, locked adjacent controls, picker expansion, no-project Session creation, and the same-node transition to an editable textarea. The assembled Web helper begins through the textarea, so replayed browser scenarios exercise the shipped path.
