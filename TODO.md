# Coding delivery record

This file is the cross-session implementation record for Coding. Update it when a decision, phase boundary, shipped behavior, or verification status changes.

## Product boundary

- Product and application name: `Coding`.
- Public Linux command: `coding`; do not add a `dsh` alias.
- Internal package names, plugin identifiers, wire protocol names, `$DSH_HOME`, and the `~/.dsh` default stay compatible with DeepSeek Harness (`dsh`) for this program of work.
- macOS and Windows ship the native desktop GUI. Linux ships the interactive terminal UI. The first supported release matrix is macOS arm64, Windows amd64, and Linux amd64.

## Architecture decisions

- The TypeScript/Cordis Node Host remains the sole owner of agents, sessions, tools, settings, credentials, plugins, and persistence. Go owns native process launch, desktop-window lifecycle, and the Linux terminal presentation; it does not duplicate business rules.
- `apps/desktop` uses `github.com/webview/webview_go` and navigates directly to the loopback URL served by the existing Web profile. It does not add a proxy or replace the `/api` transport.
- `apps/tui` uses Bubble Tea and Lip Gloss. It consumes the existing unary HTTP plus `events.mux` and `events.host` WebSocket protocol, including reconnect generations. First-party Host features reach feature parity with the Web GUI; third-party browser-only client plugins render a non-executable placeholder with their id and JSON projection.
- GUI and TUI share `$DSH_HOME`. At most one same-version Host owns that home. Clients read `$DSH_HOME/host.json`, verify loopback reachability and protocol/version compatibility, and attach to a live Host; stale records are replaced only after the recorded PID is no longer alive or the endpoint is unreachable.
- The Host binds `127.0.0.1:0` for Go-managed launches and emits one machine-readable readiness line after the complete Web tree settles. The record contains port, pid, version, and protocol. A Host with no connected clients and no running Agent or background task exits after five minutes and removes its own record.
- Desktop startup uses the user's home directory as Host cwd unless `--cwd <dir>` is supplied. The Host's existing `session.create` fallback applies this value to new sessions.
- Release launchers embed a Node SEA bootstrapper. On first run it materializes the production Host closure and native sidecars into `$DSH_HOME/runtime/<version>`, verifies the content SHA-256, then starts the Host from that directory. A successful current-version startup removes older runtime versions; failures leave them available. Linux embeds this SEA asset into one `coding` executable, while native sidecars remain materialized files.
- Initial distribution is manual installation only: macOS `.app`/`.dmg`, Windows installer, and one Linux executable. Signing and notarization hooks are prepared but do not block development; automatic update is excluded.

## Phase 0: identity and design record

Status: done.

- [x] Record the product name and delivery decisions in this file.
- [x] Update paired root README files with Coding identity and client platform matrix.
- [x] Add the proposed architecture Agent Note for the shared Host and Go-client decision.
- [x] Add user-facing desktop and terminal installation guides (`docs/user/guide/install.md` bilingual pair).

Acceptance: the product name, supported platforms, compatibility boundary, and implementation ownership are visible in the root README and Agent Note; bilingual and Agent Note checks pass.

## Phase 1: shared Host lifecycle

Status: implemented; verification below is the current record.

- [x] Add a Go-launchable Web-profile mode: loopback host, port zero, no browser handoff, no human-only readiness dependency. (`apps/cli` `web --coding-host`, `packages/bundle/web-app/src/startup.ts`)
- [x] Emit a one-line JSON readiness record only after the complete loader tree has settled. (`managed-host.ts`, frame `coding-host-ready`)
- [x] Write and atomically replace `$DSH_HOME/host.json`; remove it only when its owning Host exits (token-guarded cleanup).
- [x] Implement stale-record validation with PID liveness, version/protocol comparison, and loopback health probing. (`apps/internal/hostlaunch`)
- [x] Track WebSocket client attachment plus active Agent/background-task state; stop after five idle minutes. (`packages/client/connection/src/web-client-connections.ts`)
- [x] Cover readiness, record ownership, stale takeover, idle termination, and `--cwd` with Host tests and update the GUI prompt snapshot. (`packages/bundle/web-app/tests/managed-host.spec.ts`; live `SIGTERM` smoke passed)

Acceptance: two local clients sharing one home attach to one compatible Host, a stale Host record is safely replaced, and an idle Host exits without removing another Host's record.

## Phase 2: desktop GUI shell

Status: in progress (dev form on macOS; single-instance + WebView2 check wired; platform smoke pending).

- [x] Create `apps/desktop` Go module and shared launcher package. (`apps/desktop`, `apps/internal/hostlaunch`)
- [x] Parse `--cwd`; discover or start the Host; wait for readiness; navigate a `webview_go` window to its loopback URL.
- [x] Use `Coding` in the window title, application metadata, and installer metadata. (window title; installer metadata pending packaging)
- [x] Implement platform single-instance behavior: forward a second invocation's arguments and focus the existing window. (`apps/desktop/internal/instance`)
- [x] Detect missing Windows WebView2 and present a recovery path. (`apps/desktop/internal/webview2`; macOS `.app`/`.dmg` packaging pending)
- [ ] Smoke-test fresh launch, existing-Host attach, second-instance focus, and post-close idle shutdown on the supported desktop platforms.

Acceptance: macOS arm64 and Windows amd64 launch the unchanged Web GUI through a native window without requiring a separately installed Node runtime.

## Phase 3: SEA runtime and distribution assembly

Status: done (macOS arm64 cold-start smoke passed; Windows/Linux platform runs pending CI workflow).

- [x] Produce the production `@deepseek-ai/dsh` dependency closure with `pnpm deploy` or an equivalent locked manifest. (`apps/runtime` + `scripts/build-coding-runtime.ts`; full run verified on darwin-arm64)
- [x] Build a CommonJS SEA bootstrapper with `createRequire(__filename)`, `useCodeCache: false`, and `useSnapshot: false` for cross-platform assets. (`scripts/sea/bootstrap.cjs`)
- [x] Embed the compressed closure, manifest version, and SHA-256; materialize it atomically and rebuild damaged runtime directories. (verified: cold start materializes and serves)
- [x] Package required native sidecars, including `landlock-run`, ripgrep, and Windows koffi dependencies, beside the materialized runtime. (deploy closure carries them)
- [x] Clean old runtime versions only after a current-version Host reports readiness.
- [x] Test cold start, corruption recovery, successful cleanup, failed-start preservation, and real startup on all supported target platforms. (macOS arm64 real run passed: readiness line + host.json + Web UI + RPC health probe + old-version cleanup after SIGTERM; Windows/Linux pending `coding-native.yml` runs)

Acceptance: users can run a release artifact without installing Node, and the artifact always verifies or rebuilds its on-disk runtime before launch.

## Phase 4: Linux interactive CLI

Status: in progress (panels wired for workspaces/skills/presets/settings/models/jobs/subagents/goals; operations and remaining panels pending).

- [x] Create `apps/tui` Go module using Bubble Tea and Lip Gloss, distributed as `coding` on Linux amd64.
- [x] Implement the `/api` RPC envelopes and both downlink WebSocket streams with runtime validation and reconnect-generation behavior matching `ConnectionController`. (`internal/tui/client.go`)
- [x] Implement session list/create/resume, prompt send, streamed replies, Ctrl+C interrupt, and approval/question answering via `POST /api/respond`. (approvals y/n; questions submit first option, cancel via Esc)
- [x] Implement workspace management, tool summary, jobs, subagents, goals, skills and slash commands, model/credential settings, agent presets, plugin/settings inventory, session ZIP export, and token/context displays. (read-only panels: `internal/tui/panels.go` Ctrl+P; export helper `ExportSessionZIP`; write interactions pending)
- [x] Show unsupported third-party Web client plugin UI as a non-executable placeholder with plugin id and default JSON projection. (plugins panel placeholder)
- [x] Keep all settings, credentials, and session data under the shared `$DSH_HOME`. (launcher/Host mechanism; no TUI-local storage)
- [ ] End-to-end keyless mock-LLM session test through the TUI transport.

### TUI initial key map

| Key | Action |
| --- | --- |
| `Ctrl+C` | Interrupt the active turn; exit only when no active turn remains. |
| `Ctrl+N` | Create or focus a fresh session. |
| `Ctrl+P` | Open the session/workspace picker. |
| `Ctrl+L` | Open the command palette. |
| `Ctrl+,` | Open settings. |
| `Tab` / `Shift+Tab` | Move focus between visible regions. |
| `Enter` | Submit the composer or confirm the focused action. |
| `Esc` | Cancel the current overlay, picker, or pending answer. |
| `/` | Start a slash command in the composer. |

Acceptance: first-party Web GUI workflows can be completed through `coding` against a new or existing shared Host, with an end-to-end keyless mock-LLM session test.

## Phase 5: build, CI, and release

Status: in progress (opt-in workflow added; packaging metadata pending).

- [x] Add `build:runtime`, `build:desktop`, `build:tui`, and `release:desktop` scripts without changing the current keyless CI contract.
- [x] Add an opt-in, credential-free platform build workflow for darwin/arm64, windows/amd64, and linux/amd64; keep publication out of CI. (`.github/workflows/coding-native.yml`; `.github/AGENTS.md` updated)
- [ ] Add release packaging metadata, notices, checksums, and manual installation instructions. (workflow emits checksums; `.app`/installer packaging pending)
- [ ] Run the narrow TypeScript, Go, runtime, GUI, and TUI test sets required by changed behavior, then `git diff --check`.

Acceptance: CI can build every target without secrets, and a manually installed artifact passes the platform smoke checks documented above.
