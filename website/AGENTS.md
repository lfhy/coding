# AGENTS.md — Documentation website adapter

Follow the [root instructions](../AGENTS.md), the [documentation standard](../docs/AGENTS.md), and the [documentation-site sync workflow](../.agents/skills/dsh-doc-site-sync/SKILL.md).

## Keep documentation content out of this tree

`website/` owns only VitePress configuration, presentation assets, and the publication manifest. This file is the only maintained Markdown file in this subtree.

Keep canonical prose and generated catalogs in their owning `docs/` tier, then expose selected pages through [docs.ts](docs.ts). 站点是单语言中文：`docs.ts` 把每个定稿 `foo.md` 投影到 `root` locale，不存在 `en/` 路由树或英文侧边栏。Never add locale, route, API, or copied documentation trees such as `website/zh-CN/`, `website/en/`, or `website/api/`.

The projector writes disposable Markdown to the ignored `website/.generated/` directory. Never edit or commit `.generated/`, `.cache/`, or `.dist/`.

Run `pnpm docs:check` after changing this subtree; the gate rejects additional non-ignored Markdown under `website/`.
