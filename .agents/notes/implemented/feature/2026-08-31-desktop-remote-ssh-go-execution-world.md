# Agent Note: Desktop Remote-SSH uses a Go execution-world agent

Status: implemented

English | [中文](2026-08-31-desktop-remote-ssh-go-execution-world.zh.md)

## Problem

Remote workspaces must keep the local Coding Host as the owner of Sessions, durable logs, credentials, approval, settings, model transport, and UI, while filesystem paths, processes, terminals, language servers, search, and Code Mode execute against the selected remote directory. A marker that routes only some tools creates a split execution world: generic consumers either fail or risk acting on the local marker alias. Requiring Node on the target merely to run TypeScript also makes the remote deployment much larger than the capability it supplies.

## Decision

The desktop Remote-SSH connection gateway from [Desktop Remote-SSH connection gateway](2026-08-30-desktop-remote-ssh-tool-gateway.md) deploys one loopback-only Go agent. The local Node Host remains the product control plane; the Go binary is the remote execution plane. The authenticated desktop bridge carries only requests whose marker root, remote root, connection id, and generation match the currently published identity, and never falls back to a local path or process when that identity is unavailable.

For a marker target, `dsh-fs-local` keeps semantic filesystem operations in the selected remote root and publishes the remote canonical process path and provider-platform `file:` URI to consumers. `dsh-subprocess-local` verifies that same marker identity for executable lookup, ordinary managed processes, and PTY allocation, then forwards argv, explicit environment entries and tombstones, byte streams, termination, and liveness operations to the Go agent. Foreground and background Bash, persistent terminals, and LSP therefore use the selected remote execution world rather than a marker-shaped local directory.

`glob` and `grep` use a selected-root native Go search route on marker workspaces. The route applies request-time root checks plus its own result, read, and response bounds; an incomplete remote search fails instead of presenting a partial result as complete.

Every Code Mode, ordinary-process, and PTY start carries a fresh 32-character lowercase-hex nonce. The agent keys it by canonical root and a fingerprint of the start input, so a response-loss retry returns the initially published handle and a changed input is rejected. Before publication, recovery revalidates the current marker identity and fails closed on a rebind instead of using the old connection; after publication, the captured owner is limited to explicit termination or cancellation cleanup. Reads, writes, starts, waits, and Code Mode polling or replies never use a retired identity.

`WorkerThreadCodeRuntime` selects the remote implementation when `CodeRunRequest.cwd` identifies a current marker. For every run, the agent re-execs a constrained child with the positive `memoryLimitBytes` and `computeMs` supplied by the local Host; only that child transforms the TypeScript program with esbuild and runs it in a fresh Goja isolate. It has no HTTP listener or retained session table, so an OOM or forced child exit ends that run while the parent agent remains available. The child accumulates only active Goja program and promise-continuation execution against `computeMs`, not time waiting for a local Host binding reply; a hot loop ends as `timeout`. Its polling session sends console output and binding calls to the local Host; the Host still executes each tool call through the ordinary tool pipeline, including approval and durable Code Mode dispatch logging, then returns the lossless JSON result or rejection to the isolate. Start, polling, and reply operations revalidate the marker, so rebinding cannot let an old session control the new connection. After a start has been accepted and published, any marker, next, or reply failure, cancellation, or teardown may use its captured owner only to best-effort cancel that old session; it never selects a newly rebound connection or runs start, polling, or reply. The agent retains completed sessions for two minutes and admits at most eight active-or-retained sessions; a full table rejects a new start with `code-session-limit`. The remote runtime exposes no Node installation, Node built-ins, ambient Host environment, or direct tool authority.

Remote filesystem and search targets, plus managed-process working directories, are checked against the selected root when each request is resolved, including lexical and resolved-symlink escapes. The root is an execution coordinate and path policy, not a filesystem or OS sandbox; it does not defend against a target-side concurrent replacement of a checked symlink or ancestor. Filesystem `workspace-write` retains its semantic path fence, while a remote shell or language server needs `danger-full-access` until a same-world remote sandbox provider exists. Connection ids, process handles, terminal sessions, and Code Mode polling sessions are memory-only; a bridge or desktop shutdown invalidates them and requires the user to reconnect rather than restoring them from durable state.

This note realizes the generic provider rule in [Portable consumers over filesystem and subprocess execution worlds](../architecture/2026-07-28-portable-execution-world-consumers.md) for desktop marker targets. The earlier connection-gateway note continues to own SSH authentication, host-key confirmation, marker rebinding, and local bridge authentication.

## Alternatives considered

**Keep the foreground filesystem-and-Bash gateway.** Rejected because background handles, PTYs, language servers, search, and Code Mode would either fail or need consumer-specific remote adapters, violating the execution-world contract.

**Deploy a Node runtime and move the existing worker unchanged.** Rejected because remote Code Mode needs a callback protocol and tool authority routing as well as a JavaScript engine. Goja plus esbuild ships in the Go agent without a target-side Node runtime, while the local Host retains the authority-bearing callback half.

**Embed [ts-engine](https://github.com/viveke22/ts-engine).** Rejected because the evaluated interpreter does not implement async/await or arrow functions, which Code Mode needs for top-level await and its generated SDK. It also deliberately exposes `fetch`, filesystem APIs, and HTTP modules, conflicting with the binding-only remote authority boundary. Confining and extending it would require a substantive fork plus the same callback protocol.

**Run the whole Coding Host remotely.** Rejected because it moves Session durability, credentials, settings, model transport, and the UI ownership that the desktop picker is intended to retain locally.

**Implement remote filesystem and search through ad-hoc shell commands.** Rejected because it loses typed filesystem identity, versioned mutation semantics, bounded byte transport, and process/terminal lifecycle guarantees already used by generic consumers.

## Consequences

Remote-SSH delivers the same filesystem, process, terminal, LSP, search, and Code Mode capability families to a selected remote workspace without uploading Node. The local Host remains the sole owner of model-visible execution, approvals, and session logs; a remote program cannot bypass that ownership through a direct tool binding.

The Goja implementation is a TypeScript execution substrate, not a Node compatibility layer. Programs that rely on Node globals, built-in modules, native addons, or process-local Host state fail rather than gaining an undeclared remote capability. Remote process and terminal lifecycle is available only while the selected SSH connection and desktop bridge remain live; Coding does not persist credentials, reconnect automatically, or resurrect live handles after restart.

Focused Go coverage pins request-time root checks, strict wire decoding, managed process and PTY lifecycle, native search bounds, and Code Mode polling/reply/cancellation. It also proves that a memory-limited child can die while `/v1/health` and a following code run remain available. Focused TypeScript coverage pins marker-target routing, remote stream and handle behavior, LSP workspace resolution, search rendering, and local execution of remote Code Mode bindings.
