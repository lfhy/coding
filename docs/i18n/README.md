# 文档语言与历史配对兼容

仓库文档默认只维护中文，使用无语言后缀的 `foo.md` 作为 canonical 文件。新增普通文档不创建 `foo.zh.md` 或 `foo.i18n.yaml`，修改普通文档也不承担新增或补齐英文对侧文件的义务。这项规则只约束仓库文档；产品 UI、locale 字典、协议 locale 与系统 i18n 继续按各自契约维护。

本页同时保留历史双语三件套的兼容约定。现有未触及的配对无需批量删除，`verify-translation-pairing` 仍会严格检查它们；流程取舍见[中文单文档 Agent Note](../../.agents/notes/implemented/process/2026-09-19-chinese-canonical-documentation.md)。

## 中文单文档流程

- 新文件直接写入 `foo.md`，正文使用简体中文，不添加语言切换行。
- 修改普通的历史配对时，默认以 `foo.zh.md` 的中文内容覆盖 `foo.md`，移除语言切换行，并在同一变更中删除 `foo.zh.md` 与 `foo.i18n.yaml`。所有仓库内链接继续指向无后缀的 `foo.md`。
- 迁移前先用 `rg` 查找指向将删除 `.zh.md` 的链接；迁移后运行 `verify-md-links`。不要把全仓历史配对清理捆绑到一次普通文档改动中。
- 由生成器固定输出英文的文档、文档站仍显式发布双语的页面，或用户明确要求保留的配对，可以暂时保持三件套。只要配对产物仍存在，就必须满足下方完整约定。
- 产品源码中的用户文案、locale 资源和运行时语言选择不属于文档迁移范围，不得借此删除或合并。

<a id="the-pairing-contract"></a>

## 历史配对约定

一个 legacy pair 由同目录的 `foo.md`、`foo.zh.md` 和 `foo.i18n.yaml` 三个文件组成。伴随记录保存两侧上次确认一致时的完整 Git blob hash；任何一侧发生变化后，保留配对的变更都必须同步另一侧，再运行：

```sh
pnpm run verify-translation-pairing --write path/to/foo.md
pnpm run verify-translation-pairing path/to/foo.md
```

两侧继续遵守历史结构要求：中文文件在 H1 后以 `[English](foo.md) | 中文` 链回，普通撰写的英文文件以 `English | [中文](foo.zh.md)` 互链；标题深度、代码围栏、表格行列、列表类型与数量，以及除切换行外的链接目标保持对应。完整翻译规则见 [translation-rules.md](translation-rules.md)，术语见 [terminology.md](terminology.md)。

记录的 blob 同时是恢复指针。显式调用旧翻译工作流时，`pnpm run gen-translation-brief <pair>` 可从上次确认内容生成最小更新简报；自动合并驱动仍只在两侧文本都能干净合并且结构有效时组合 `.i18n.yaml`。这些工具仅服务现存或明确要求的新配对，不参与普通中文文档编辑。

## 门禁行为

无参数的 `pnpm run verify-translation-pairing` 只发现现存的 `.zh.md` 与 `.i18n.yaml` 产物，并对由它们锚定的三件套执行以下检查：

1. 三个文件必须完整；只删除一侧或只留下伴随记录会失败。
2. 两侧当前 blob hash 必须等于伴随记录；结构、生成区域和语言切换行必须满足历史约定。
3. [translation-pairing.manifest.json](../../scripts/translation-pairing.manifest.json) 中列为 `excluded` 的路径不得出现 `.zh.md` 或 `.i18n.yaml`。
4. 无语言后缀且没有任何配对产物的 `.md` 是合法中文单文档，不进入配对状态表，也不会显示为 `missing`。

`pnpm run verify-translation-pairing --list` 只列出现存 legacy pair 的 `ok`、`out-of-sync` 或 `missing` 状态。限定路径的检查仍适合保留配对的更新循环；对已经完整迁移成单文件的路径，它是无配对可检查的空操作。`--write` 只能用于两侧都存在的配对，不能为单文档自动创建英文文件。

门禁通过只证明记录 hash 与 Markdown 结构一致，不能判断翻译是否准确自然。保留配对时，语义一致性仍由评审负责。

<a id="scope-and-exclusions"></a>

## 兼容范围与归档

配对发现范围仍覆盖根目录指定文档、非 vendor README，以及 `.agents/notes/**`、`docs/**` 和 `python/**` 下的文档产物；依赖目录、构建输出、vendor 与冻结的 `.agents/notes/archived/` 不进入持续配对发现。这个范围只定义「出现 legacy pair 时如何验证」，不再要求范围内每个 `.md` 都有对侧文件。

冻结的 Agent Note 由 `verify-archived-agent-notes` 单独封存。历史归档三件套保持原样；新的中文单文档归档只封存一份 `.md`。两种形态一经写入归档 manifest 都不得修改。

<a id="division-of-labor"></a>

## 工作分工

普通文档工作直接编辑中文 canonical，不加载术语表、不生成翻译简报，也不运行配对重录。可与功能实现解耦的大段文档工作优先委派为独立子任务，主任务负责提供事实边界与验收。

只有用户明确要求翻译或变更明确保留 legacy pair 时，才使用 [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md)。翻译提示词仍可服务这类显式任务，其金标使用冻结 fixture，不再与当前流程政策文档耦合。
