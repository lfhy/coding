# Agent Note: Coding Go clients share one Node Host

Status: proposed

English | [中文](2026-08-20-coding-go-clients-shared-node-host.zh.md)

## Problem

Coding needs a native GUI on macOS and Windows plus an interactive Linux terminal UI, while the existing Node/Cordis Host already owns sessions, agents, tools, credentials, settings, plugins, and the browser RPC contract. Reimplementing those services in Go would create two incompatible persistence and protocol owners.

## Proposal

Coding keeps the TypeScript/Cordis Node process as the only business Host. Go applications own native launch and presentation only: `apps/desktop` hosts the existing Web GUI in `webview_go`, and `apps/tui` consumes the existing `/api` unary HTTP plus `events.mux` and `events.host` downlinks. Both applications share `$DSH_HOME` and connect to one compatible local Host advertised by `host.json`.

Go-managed Host launches bind loopback on an OS-selected port and report readiness as structured JSON after the full Web tree settles. A Host record carries its port, PID, runtime version, and protocol version. Launchers validate reachability and compatibility before attaching; a stale or incompatible record is replaced only after its owner is gone. The Host removes only the record it owns and stops after five minutes with neither clients nor active Agent/background work.

Release launchers embed a Node SEA bootstrap asset. It materializes a verified production closure and required native sidecars under `$DSH_HOME/runtime/<sha256>` before starting the Host. The directory name is the archive content hash, so a later product version that ships the same bytes reuses that directory. Successful startup removes older runtime directories; a failed startup preserves them. This keeps Node out of the end-user prerequisite list without claiming that native sidecars can live inside a pure single executable.

The Coding product name and public Linux command do not rename the internal `@deepseek-ai/dsh` package, plugin, protocol, or data-home identifiers. The existing semantics remain the compatibility boundary while product-facing artifacts use Coding. The cross-session delivery record in [TODO.md](../../../TODO.md) owns the phased implementation status and detailed acceptance work.

## Alternatives considered

**Port the Host to Go** — rejected because it duplicates the agent, persistence, plugin, and RPC implementation and would require an ongoing cross-language feature-parity program.

**Use Wails or a desktop HTTP proxy** — rejected because `webview_go` can navigate directly to the loopback Host, preserving the existing Web transport and its loopback trust policy without another same-origin layer.

**Require users to install Node** — rejected because a SEA bootstrapper can package the Host closure while preserving materialized native dependencies where Node modules require files.

**Restore the removed Node TUI** — rejected because the old package was intentionally removed as an unshipped frontend in the [TUI removal decision](../../implemented/simplification/2026-08-04-remove-tui-package.md). A new Go TUI is a distinct product client that consumes the maintained HTTP/WebSocket protocol instead of reviving the old frontend dependency graph.

## Acceptance criteria

- The Host can publish and clean up a versioned local discovery record, and Go clients attach only after PID, protocol, version, and loopback RPC checks succeed.
- `apps/desktop` opens the existing Web application inside a native macOS arm64 or Windows amd64 WebView without introducing a second HTTP transport.
- `apps/tui` is a Linux amd64 Bubble Tea application that validates the existing RPC envelopes and reconnects both downlinks by generation.
- Release artifacts materialize a checksum-verified Host runtime under `$DSH_HOME/runtime/<sha256>` and do not require a globally installed Node executable.
- First-party workflows remain owned by the Node Host; browser-only third-party client views render a non-executable TUI placeholder.

## Risks

- Host discovery is a cross-process ownership protocol. A launcher lock and record-token cleanup are required so concurrent launchers cannot create competing writers for one `$DSH_HOME`.
- Node SEA packages JavaScript into one executable but native modules still need files. The runtime assembly must preserve platform sidecars and validate every target rather than claiming a pure universal binary.
- The Go TUI has no generated TypeScript contract bindings. It must decode the stable wire envelopes defensively and keep its supported feature matrix explicit until a fixture-backed compatibility suite covers the full first-party API.

Host tests cover readiness records, stale-record takeover, runtime-version compatibility, and idle termination. SEA tests cover cold materialization, corruption recovery, and cleanup only after readiness. Desktop and TUI tests cover attachment to an existing Host, reconnect behavior, and the first-party client workflows each presentation exposes.
