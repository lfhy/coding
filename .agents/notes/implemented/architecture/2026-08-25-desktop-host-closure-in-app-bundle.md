# Agent Note: Desktop Host closure ships pre-expanded in the app bundle

Status: implemented

English | [中文](2026-08-25-desktop-host-closure-in-app-bundle.zh.md)

## Problem

The macOS desktop app launched a Node SEA bootstrapper whose first run unpacked the production Host closure into `$DSH_HOME/runtime/<sha256>`. The desktop package already has a signed, read-only resource tree, so this copy made a new installation wait before the Host could begin its ordinary Node and plugin initialization.

## Decision

`scripts/build-coding-runtime.ts` deploys the production closure once, rejects remaining symbolic links, and emits a raw Node executable, `dist/coding-runtime/coding-node-<target>`, plus `dist/coding-runtime/runtime`. `scripts/package-macos-app.sh` places those outputs at `Coding.app/Contents/Resources/coding-host` and `Coding.app/Contents/Resources/runtime`, with the build metadata beside them.

`apps/internal/hostlaunch` starts the packaged Node executable with `runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web --coding-host`. The closure remains read-only in the application bundle; `$DSH_HOME` retains sessions, settings, credentials, plugins, discovery records, and other mutable user data. The Linux terminal continues to use the content-hash SEA materialization policy in [the SEA runtime-directory decision](2026-08-22-sea-runtime-directory-by-content-hash.md).

## Alternatives considered

**Keep desktop SEA materialization in `$DSH_HOME`.** Rejected because the first desktop launch copies a closure that the signed application bundle can carry directly.

**Point `$DSH_HOME/runtime` at the app bundle with a symbolic or hard link.** Rejected because moved or replaced applications leave stale links, hard links require a shared filesystem, and the desktop launcher can derive the resource path without either indirection.

**Load the closure directly from SEA assets.** Rejected because ordinary Node resolution and native sidecars require real files. The pre-expanded bundle provides those paths without a user-home extraction.

## Consequences

The macOS application is larger because it contains the expanded closure, but a desktop cold launch does not unpack Host files or mutate `$DSH_HOME`. Packaging fails when the direct Node executable, entry module, or metadata is absent, and the launcher fails loudly when a packaged entry is missing. The normal Node, Web Host, and client-plugin initialization still occurs on every new Host process.

## Testing

`apps/internal/hostlaunch` tests the direct packaged command and its missing-entry failure. `scripts/check-runtime-start.sh` starts the generated raw Node executable against the generated closure in a clean `DSH_HOME`, and the macOS packaging script verifies the required build outputs before signing the app.
