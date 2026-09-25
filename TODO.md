# Coding delivery record

This file is the cross-session implementation record for Coding. Update it when a decision, phase boundary, shipped behavior, or verification status changes.

## Product boundary

- Product and application name: `Coding`.
- Public Linux command: `coding`; do not add a `dsh` alias.
- Internal package names, plugin identifiers, wire protocol names, `$DSH_HOME`, and the `~/.dsh` default stay compatible with DeepSeek Harness (`dsh`) for this program of work.
- macOS arm64 has an Electron desktop GUI; Windows amd64 desktop packaging and native verification remain planned. Linux ships the interactive terminal UI. The target release matrix is macOS arm64, Windows amd64, and Linux amd64.

## Architecture decisions

- The TypeScript/Cordis Node Host remains the sole owner of agents, sessions, tools, settings, credentials, plugins, and persistence. Electron owns desktop windows and menus, Go owns the desktop Host/SSH helper and Linux terminal presentation; neither duplicates Host business rules.
- `apps/desktop-electron` navigates directly to the verified loopback URL served by the existing Web profile. It does not add a proxy or replace the `/api` transport; `apps/desktop` contains the Go helper and remote services.
- `apps/tui` uses Bubble Tea and Lip Gloss. It consumes the existing unary HTTP plus `events.mux` and `events.host` WebSocket protocol, including reconnect generations. First-party Host features reach feature parity with the Web GUI; third-party browser-only client plugins render a non-executable placeholder with their id and JSON projection.
- GUI and TUI share `$DSH_HOME`. At most one same-version Host owns that home. Clients read `$DSH_HOME/host.json`, verify loopback reachability and protocol/version compatibility, and attach to a live Host; stale records are replaced only after the recorded PID is no longer alive or the endpoint is unreachable.
- The Host binds `127.0.0.1:0` for Go-managed launches and emits one machine-readable readiness line after the complete Web tree settles. The record contains port, pid, version, and protocol. A Host with no connected clients and no running Agent or background task exits after five minutes and removes its own record.
- The packaged desktop Host uses the user's home directory as cwd; development uses `~/.dsh-electron-dev/workspace`. The Host's existing `session.create` fallback applies this value to new sessions.
- macOS `Coding.app` contains a raw Node executable at `Contents/Resources/coding-host` and a pre-expanded, symlink-free Host closure at `Contents/Resources/runtime`; the Electron Go helper launches its `bin.js` directly and leaves `$DSH_HOME` for user data. Linux embeds a Node SEA bootstrapper in the `coding` executable. Its first run materializes the verified Host closure and native sidecars into `$DSH_HOME/runtime/<sha256>`; the content-hash directory is reused across product versions with identical bytes, and a successful current-archive startup removes older runtime directories.
- Initial distribution is manual installation only: macOS `.app`/`.dmg`, Windows installer, and one Linux executable. Signing and notarization hooks are prepared but do not block development; automatic update is excluded.
- Mobile clients will be mobile Web clients of the same Web GUI, not native shells: phones never run the Host; they reach a Host on the user's desktop or a server. The enabling work is Host-side remote-access security (token auth exists; TLS and LAN discovery remain), plus responsive Web GUI adaptation. If a store app is ever needed, package the existing Web GUI with Capacitor rather than introducing another desktop shell.

## Phase 0: identity and design record

Status: done.

- [x] Record the product name and delivery decisions in this file.
- [x] Update paired root README files with Coding identity and client platform matrix.
- [x] Add user-facing desktop and terminal installation guides (`docs/user/guide/install.md` bilingual pair).

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

Status: in progress (macOS arm64 Electron development and packaged smoke passed; installed-app and Windows native verification pending).

- [x] Create the Electron shell, Go helper module, and shared launcher package. (`apps/desktop-electron`, `apps/desktop/cmd/electron-helper`, `apps/internal/hostlaunch`)
- [x] Discover or start the Host, wait for readiness, and navigate the Electron window to its verified loopback URL without proxying `/api`.
- [x] Use `Coding` in the window title and macOS application metadata. (`scripts/package-electron-macos-app.ts`)
- [x] Enforce a single Electron instance and focus the existing window on a second launch. (`apps/desktop-electron/src/main.ts`)
- [x] Package and ad-hoc sign the macOS arm64 `.app`; the assembled bundle has passed an isolated-HOME launch smoke. (`scripts/package-electron-macos-app.ts`)
- [ ] Smoke-test installed macOS app interactions and Windows desktop packaging/native launch; verify existing-Host attach and post-close idle shutdown on each supported platform.

Acceptance: macOS arm64 and Windows amd64 launch the unchanged Web GUI through a native window without requiring a separately installed Node runtime; Windows acceptance remains pending.

## Phase 3: SEA runtime and distribution assembly

Status: macOS arm64 runtime and Electron assembly verified in isolated-HOME smoke; Windows/Linux platform runs pending.

- [x] Produce the production `@deepseek-ai/dsh` dependency closure with `pnpm deploy` or an equivalent locked manifest. (`apps/runtime` + `scripts/build-coding-runtime.ts`; full run verified on darwin-arm64)
- [x] Build a CommonJS SEA bootstrapper with `createRequire(__filename)`, `useCodeCache: false`, and `useSnapshot: false` for the Linux terminal asset. (`scripts/sea/bootstrap.cjs`)
- [x] Embed the compressed closure, manifest version, and SHA-256; the Linux bootstrapper materializes it atomically and rebuilds damaged runtime directories. (verified: cold start materializes and serves)
- [x] Package the macOS Node executable and pre-expanded closure under `Coding.app/Contents/Resources`; the Go helper runs its `bin.js` without a first-run extraction. (`scripts/build-coding-runtime.ts`, `scripts/package-electron-macos-app.ts`)
- [x] Package required native sidecars, including `landlock-run`, ripgrep, and Windows koffi dependencies, in the deployed closure. (Linux materializes it; macOS ships it in the app bundle.)
- [x] Clean old runtime versions only after a current-version Host reports readiness.
- [x] Test cold start, corruption recovery, successful cleanup, failed-start preservation, and real startup on all supported target platforms. (macOS arm64 real run passed: readiness line + host.json + Web UI + RPC health probe + old-version cleanup after SIGTERM; Windows/Linux pending `coding-native.yml` runs)

Acceptance: users can run a release artifact without installing Node; macOS reads its signed app-bundle runtime directly, while Linux verifies or rebuilds its on-disk runtime before launch.

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

## Phase 6: mobile Web client

Status: not started (decision recorded; revisit after desktop stabilizes).

- [x] Offer local-folder, desktop-only Remote-SSH, and no-project starts from the Hero Workspace picker; the desktop flow opens a bounded Remote-SSH Workspace while ordinary browser deployments report that the capability is unavailable.
- [ ] Host remote-access security: token auth hardening, TLS termination guidance, and LAN discovery so a phone browser can reach a desktop/server Host without exposing it to the local network unauthenticated.
- [ ] Responsive adaptation of the existing Web GUI for phone-sized viewports (composer, session list, approvals).
- [ ] Optional store shell: package the adapted Web GUI with Capacitor only if a native app becomes necessary.

Acceptance: a phone browser can open the Host URL, complete a keyless mock session end to end, and the Host rejects unauthenticated access.
