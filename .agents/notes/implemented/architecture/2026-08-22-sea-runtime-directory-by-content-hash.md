# Agent Note: SEA runtime directory keyed by content hash

Status: implemented

English | [中文](2026-08-22-sea-runtime-directory-by-content-hash.zh.md)

## Problem

The Coding SEA bootstrapper materialized the Host closure under `$DSH_HOME/runtime/<version>` and treated a matching product version plus archive SHA-256 as a hit. Native launchers still publish `host.json` and `DSH_APP_VERSION` from the product version, so that label remains the live compatibility key. The on-disk directory, however, is only a cache of archive bytes. A later product version that ships the same closure still unpacked the archive again, so a rebuilt or retagged desktop app paid the first-run copy cost even when the Host files had not changed.

## Decision

`scripts/sea/bootstrap.cjs` names the materialized directory `$DSH_HOME/runtime/<sha256>`. A hit requires only that the marker's `sha256` match the embedded archive and that `node_modules/@deepseek-ai/dsh/lib/bin.js` exist. The product version remains in the marker and still owns `DSH_APP_VERSION` plus Host readiness records. After the current Host owns `host.json`, cleanup deletes every runtime sibling whose name is not the current archive hash. `scripts/build-coding-runtime.ts` fails before deploy when the complete build did not emit `apps/cli/lib/bin.js`, and fails after deploy when the staged closure omits `node_modules/@deepseek-ai/dsh/lib/bin.js`; the host tsdown workspace entry includes `lib/types/bin.js` so the built bin ships in the closure.

## Alternatives considered

**Keep the versioned directory and ignore version in the hit check.** Rejected because two product versions that share bytes would still occupy two directories until one Host started and cleaned the other.

**Load modules from SEA assets without unpacking.** Rejected because native sidecars and ordinary Node module resolution still need files on disk.

## Consequences

A later product version that ships the same archive bytes starts from the existing runtime directory. A different archive hash still unpacks once into a new directory. Host discovery continues to compare product versions, so a live Host from another product version remains incompatible even when both would share a cache directory after a restart.
