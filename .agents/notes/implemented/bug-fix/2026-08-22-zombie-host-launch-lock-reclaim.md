# Agent Note: Zombie Host launch locks are reclaimed at startup

Status: implemented

English | [中文](2026-08-22-zombie-host-launch-lock-reclaim.zh.md)

## Problem

The desktop shell boots through `hostlaunch.Ensure`, which takes `~/.dsh/host.lock` before discovery or start. The lock's only liveness story was `O_EXCL` creation plus a close-time remove. When a previous Coding or coding-host died hard (crash, `kill`, logout), the lock file stayed behind with a dead owner PID. Every later desktop launch then spent the full 30-second lock timeout re-polling a file nobody would ever release — the splash page stayed on "正在准备 Coding" the whole time, and only then surfaced a lock-timeout error.

`discover` already treats a dead-PID `host.json` as missing; the launch lock had no equivalent guard.

## Decision

`acquireLock` now reads the first line of an existing lock file as the owner PID and calls the existing `processAlive` helper. A lock whose recorded owner is dead is removed and acquisition retries immediately, so a crash-restart boot reclaims its own leftover lock instead of waiting. A live owner still holds the lock for the full timeout, and a lock with missing or unparseable content is left to the timeout path (we cannot prove it abandoned).

The reclaim uses the same primitive the desktop already trusts for single-instance sockets: stale file detected, removed, retried.

## Alternatives considered

- **Flock instead of an exclusive-create lock file.** Advisory locks release on process death automatically, but the Windows twin would need a different primitive and the current cross-process story deliberately shares one file-based scheme.
- **Lock file mtime expiry.** A long host start can legitimately exceed any fixed staleness window; owner liveness is exact where the PID is readable.

## Consequences

Crash-restart boots reach discovery within one poll interval instead of 30 seconds. A lock file is now written with a trailing newline-terminated PID line, which `readLockOwner` parses defensively. Hand-edited or corrupted lock content never blocks faster than before — it falls back to the previous timeout behavior.

## Testing

`apps/internal/hostlaunch/lock_zombie_test.go` writes a dead-owner lock and asserts `acquireLock` reclaims it with the current PID. The package suite (`go test ./...`) covers lock contention and Host attach paths.
