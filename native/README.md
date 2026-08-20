# native/

English | [中文](README.zh.md)

Native source and workspace packages maintained with DeepSeek Harness. The [`landlock-run/` workspace](landlock-run/README.md) owns the Landlock self-restrict-then-exec launcher consumed by the harness, including its architecture, three-package npm family, platform support, development workflow, and [local packaging notes](landlock-run/docs/release.md).

## Workspace boundary

`landlock-run/` and its packages belong to the repository's root pnpm workspace and lockfile. Harness consumers use the current workspace entry package during development and CI, so a launcher contract change and its consumer update can land and be tested together.

This fork has no native CI or release workflow. Build and test the matching platform package locally when changing the launcher; a future distribution decision can add platform automation and publication. The entry package retains platform packages as npm optional dependencies, so npm installs only the package matching the user's operating system and CPU.
