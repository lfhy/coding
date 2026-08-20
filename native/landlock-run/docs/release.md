# Local packaging

This personal fork has no Landlock CI, release workflow, registry credentials, or supported npm publication path. The commands below are for local verification of a matching platform package; they do not authorize publishing a package or creating a release tag.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm --dir native/landlock-run build:ts
pnpm --dir native/landlock-run typecheck
pnpm --dir native/landlock-run test:entry
```

On a Linux host, also rehearse the pack path locally:

```sh
pnpm --dir native/landlock-run build:native
pnpm --dir native/landlock-run test:launcher
node native/landlock-run/scripts/pack-release.mjs native/landlock-run/.release/npm --current-platform-only
node native/landlock-run/scripts/verify-packed-install.mjs native/landlock-run/.release/npm --current-platform-only
```

## Local tarballs

For a current-platform tarball rehearsal, always use `pack-release.mjs`, never `pnpm pack` (pnpm's pack path strips the launcher's executable bit; see [packaging.md](packaging.md)):

```sh
node native/landlock-run/scripts/pack-release.mjs native/landlock-run/dist/npm --current-platform-only
node native/landlock-run/scripts/verify-packed-install.mjs native/landlock-run/dist/npm --current-platform-only
```

A future distribution decision must define the package namespace, supported platforms, signing or registry credential ownership, release tags, and publication verification before restoring a publication procedure. Do not commit `.npmrc` files with tokens or registry overrides.
