# Agent Note: Desktop Remote-SSH is a bounded tool gateway

Status: implemented

English | [中文](2026-08-30-desktop-remote-ssh-tool-gateway.zh.md)

## Problem

The Workspace picker exposed remote navigation, but it could not open a remote directory while keeping the local Coding Host, Session log, credentials, settings, and UI. Running the complete Host remotely would split local product state or require a second deployment. Treating a small SSH helper as a complete remote execution provider would create a different defect: filesystem paths, subprocesses, PTYs, language servers, and Code Mode would appear to share one execution world when only some operations actually moved.

## Decision

The Coding desktop app provides a bounded Remote-SSH tool gateway. The picker collects one password or private key for the current connection, verifies the host against an app-private `known_hosts`, deploys a small Go agent, and lets the user choose a remote directory. The agent listens only on the remote loopback interface; the desktop process reaches it through the authenticated SSH connection. The browser receives only a per-window Wails capability token, connection progress, host-key confirmation metadata, directory listings, and non-sensitive connection ids. A pending host-key confirmation retains the public key and target identity, never the password or private key.

Selecting a directory creates a local marker under `DSH_HOME`. Its directory name is a digest of the SSH target identity and canonical remote path, so reconnecting the same target rewrites the same marker with the new in-memory connection id and idempotently resolves the existing Workspace. The marker stores no address or authentication material and holds its selected connection until the marker is rebound or the desktop shuts down; a close request cannot leave a marker pointing at a stale id. Connections and ids remain process-local: after a desktop restart, opening an existing remote Workspace fails closed until the user runs Connect Remote-SSH again. Coding does not persist credentials or reconnect in the background.

The desktop starts a loopback HTTP bridge with a token separate from the WebView token and passes its URL and token only to the local Node Host environment. Because an already-running shared Host cannot acquire that ephemeral capability, desktop startup replaces a compatible managed Host before attaching. The bridge accepts only a fixed route and method allowlist, a bounded body, a known connection id, and an authenticated loopback request.

The current gateway deliberately supports a smaller set than the portable execution-world contract:

- `dsh-fs-local` recognizes the marker for semantic file operations. Every agent request carries the selected remote root; the agent resolves existing symlinks or the nearest existing ancestor and rejects paths outside that root. Remote targets fail closed when a consumer requests a local process path or `file:` URI.
- `dsh-fs-sandbox` preserves `read-only`, confines `workspace-write` to the calling Session's mapped remote subdirectory, and allows an unfenced mutation only under `danger-full-access`.
- `dsh-bash-local` routes foreground Bash calls from a marker cwd through the agent. A relative model workdir must remain under that same marker or the tool rejects it before any local or background process starts. `dsh-bash-sandbox` permits the route only under `danger-full-access`, because the local OS sandbox cannot confine a remote shell.
- Background shell handles, PTYs, persistent terminals, filesystem search subprocesses, LSP, and a dedicated remote Code runtime are not implemented. Those process capabilities fail rather than running against the local machine or claiming remote lifecycle guarantees. The isolated Code worker remains local and may orchestrate the supported remote filesystem and foreground-Bash bindings.

Remote mutations check cancellation before publication begins, then await the definitive agent response instead of aborting the transport after a commit may have occurred. Request and complete-response limits include JSON/base64 or before/after wrappers, so a committed mutation is not reclassified as a transport failure merely because its acknowledgement is larger than the request.

This decision supersedes only the address-navigation arm of [Workspace picker offers local, remote, and no-project starts](2026-08-25-workspace-picker-local-remote-and-no-project-entry.md). That record continues to own the three-action Hero layout and no-project behavior. It does not supersede [Portable consumers over filesystem and subprocess execution worlds](../architecture/2026-07-28-portable-execution-world-consumers.md): this gateway explicitly does not present itself as a provider pair for that seam.

## Alternatives considered

**Navigate to a separately reachable remote Host.** Rejected as the only desktop path because it changes the owner of Sessions, settings, and credentials instead of opening a remote directory in the current local product. A separately deployed Host remains a valid deployment outside this picker workflow.

**Implement a complete remote filesystem/subprocess provider pair immediately.** Deferred because honest parity requires ordinary process publication, streamed output, tree-scoped cancellation and quiescence, executable lookup, PTY allocation, file URIs, LSP, and every other generic consumer. The bounded gateway fails unsupported consumers closed rather than approximating those contracts.

**Persist SSH credentials for automatic reconnection.** Rejected for this iteration because it requires a credential-reference format, OS secret-store ownership, rotation and revocation behavior, and a startup reconnection state machine. Manual reconnection trades convenience for a smaller durable security surface.

**Install Node and advertise a remote Code runtime.** Rejected because detecting or installing Node does not move the worker runtime or its callback protocol. Code Mode remains in the local isolated worker; it can orchestrate supported remote bindings, while a real same-world provider would be required for generic remote process execution and cancellation.

## Consequences

Remote file editing and foreground Bash work without installing Node on the target, while the local Host remains the sole owner of product state. Host-key changes are rejected, unknown keys require an explicit confirmation, ambient credential-shaped environment variables are scrubbed from remote commands, and remote paths cannot escape the selected root through lexical traversal or symlinks.

Desktop startup replaces a compatible managed Host before attaching so that it inherits the ephemeral bridge. Existing browsers briefly lose that Host, and remote Workspaces require manual reconnection after desktop restart or SSH loss. Unsupported execution-world consumers remain visible limitations rather than silently operating on local paths. Uploaded agent cleanup, durable credential references, automatic reconnection, and a complete remote provider pair remain separate future decisions.

Focused TypeScript tests cover marker validation, bridge authentication and response bounds, remote file/binary operations, mutation cancellation, sandbox subdirectory containment, Bash routing, and unsupported background execution. Go tests cover strict protocol decoding, root and symlink containment, process/environment handling, host-key confirmation without retained credentials, bridge and Wails bindings, connection cleanup, deterministic marker rebinding, and packaged artifact selection. The desktop build packages every supported agent target; the Web scenario pins the Remote-SSH entry, while component tests pin the wizard-visible copy.
