# Agent Note: Direct build entrypoint detection

Status: implemented

English | [中文](2026-08-24-direct-build-entrypoint.zh.md)

## Problem

`scripts/build-coding-runtime.ts` launches `scripts/build.ts` through `node --import tsx/esm`. The build must emit fresh client bundles before the runtime deploy copies `lib/` artifacts; otherwise a desktop installation can contain source changes that are absent from the packaged Host.

`import.meta.main` is not a reliable entrypoint signal for that TypeScript launch form on every Node runtime used locally. A false value lets the child exit successfully without running the build, so runtime packaging copies pre-existing client artifacts and reports a successful install.

## Decision

`scripts/build.ts` compares `import.meta.url` with `process.argv[1]` converted through `pathToFileURL(resolve(...))`. The script runs its build only when those URLs match. This uses Node's invocation path directly and preserves import safety for tests and helper callers.

`scripts/build.spec.ts` pins direct execution, importing another path, and an absent invocation path. The desktop runtime build therefore rebuilds the sidebar bundle before the SEA archive receives it.

The [content-addressed SEA runtime directory](../architecture/2026-08-22-sea-runtime-directory-by-content-hash.md) owns cache selection after the archive is built; this note owns the direct build invocation that produces that archive.


## Alternatives considered

**Keep `import.meta.main`.** It is concise, but an unavailable signal lets a production build succeed without producing current artifacts.

**Rely on the supported Node version range.** The range remains useful, but version selection must not turn a build into a successful no-op when a local environment falls outside it.

**Build the sidebar package separately before every desktop install.** This would duplicate the repository build sequence and leave other client packages vulnerable to the same stale-artifact path.

## Consequences

The build entrypoint has one explicit ESM check and one focused test. `make install` continues to use the complete client build, and a packaged Host reflects the source tree rather than an older `lib/` directory.
