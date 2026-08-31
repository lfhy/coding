# Agent Note: Desktop Remote-SSH connection gateway

Status: implemented

English | [中文](2026-08-30-desktop-remote-ssh-tool-gateway.zh.md)

## Problem

The Workspace picker must open a remote directory while keeping the local Coding Host, Session log, credentials, settings, and UI. Running the complete Host remotely would split local product state or require a second deployment. The desktop connection needs a selected-root identity and an authenticated transport that expose neither credentials nor a locally reachable remote Host to the browser.

## Decision

The Coding desktop app provides a bounded Remote-SSH tool gateway. The picker collects one password or private key for the current connection, verifies the host against an app-private `known_hosts`, deploys a small Go agent, and lets the user choose a remote directory. The agent listens only on the remote loopback interface; the desktop process reaches it through the authenticated SSH connection. The browser receives only a per-window Wails capability token, connection progress, host-key confirmation metadata, directory listings, and non-sensitive connection ids. A pending host-key confirmation retains the public key and target identity, never the password or private key.

Selecting a directory creates a v2 local marker under `DSH_HOME`: `{ version: 2, remoteRoot, connectionId, generation }`. Its directory name is a digest of the SSH target identity and canonical remote path, so reconnecting the same target idempotently resolves the existing Workspace. Each official selection atomically publishes a new in-memory connection id and a monotonically increasing generation before routing requests. Target keys and bridge requests identify the marker root, remote root, connection id, and generation; an unpublished or stale identity fails closed and never selects the old connection or a local execution world. The marker stores no address or authentication material. Connections and ids remain process-local: after a desktop restart, opening an existing remote Workspace fails closed until the user runs Connect Remote-SSH again. Coding does not persist credentials or reconnect in the background.

The desktop starts a loopback HTTP bridge with a token separate from the WebView token and passes its URL and token only to the local Node Host environment. Because an already-running shared Host cannot acquire that ephemeral capability, desktop startup replaces a compatible managed Host before attaching. The bridge accepts only a fixed route and method allowlist, a bounded body, the current four-part marker identity, and an authenticated loopback request.

The marker and bridge are the transport and selected-root foundation for [Desktop Remote-SSH uses a Go execution-world agent](2026-08-31-desktop-remote-ssh-go-execution-world.md). That decision owns filesystem, subprocess, terminal, search, LSP, and Code Mode execution on the Go agent; this one continues to own connection establishment, marker lifecycle, and browser/Host credential boundaries.

Remote mutations check cancellation before publication begins, then await the definitive agent response instead of aborting the transport after a commit may have occurred. Request and complete-response limits include JSON/base64 or before/after wrappers, so a committed mutation is not reclassified as a transport failure merely because its acknowledgement is larger than the request.

This decision supersedes only the address-navigation arm of [Workspace picker offers local, remote, and no-project starts](2026-08-25-workspace-picker-local-remote-and-no-project-entry.md). That record continues to own the three-action Hero layout and no-project behavior. The Go execution-world decision realizes the provider rule in [Portable consumers over filesystem and subprocess execution worlds](../architecture/2026-07-28-portable-execution-world-consumers.md) for marker targets.

## Alternatives considered

**Navigate to a separately reachable remote Host.** Rejected as the only desktop path because it changes the owner of Sessions, settings, and credentials instead of opening a remote directory in the current local product. A separately deployed Host remains a valid deployment outside this picker workflow.

**Persist SSH credentials for automatic reconnection.** Rejected for this iteration because it requires a credential-reference format, OS secret-store ownership, rotation and revocation behavior, and a startup reconnection state machine. Manual reconnection trades convenience for a smaller durable security surface.

**Persist live remote handles across a reconnect.** Rejected because an SSH reconnection cannot reconstruct a running process tree, PTY foreground group, pending code callback, or retained output cursor safely. The execution-world agent therefore treats bridge loss as the end of its in-memory handles.

## Consequences

The remote target needs no Node runtime, while the local Host remains the sole owner of product state. Host-key changes are rejected, unknown keys require an explicit confirmation, and ambient credential-shaped environment variables are scrubbed from remote commands. Request-time validation rejects lexical and resolved-symlink escapes from the selected root; that path policy is not an OS sandbox and does not defend against a target-side concurrent replacement of a checked symlink or ancestor.

Desktop startup replaces a compatible managed Host before attaching so that it inherits the ephemeral bridge. Existing browsers briefly lose that Host, and remote Workspaces require manual reconnection after desktop restart or SSH loss. Uploaded agent cleanup, durable credential references, and automatic reconnection remain separate decisions.

Focused TypeScript tests cover marker validation, bridge authentication and response bounds, remote file/binary operations, mutation cancellation, sandbox subdirectory containment, and marker routing. Go tests cover strict protocol decoding, request-time root and symlink escape checks, host-key confirmation without retained credentials, bridge and Wails bindings, connection cleanup, deterministic marker rebinding, and packaged artifact selection. The desktop build packages every supported agent target; the Web scenario pins the Remote-SSH entry, while component tests pin the wizard-visible copy.
