# AGENTS.md — 文档规范

本文件规定文档结构、Markdown 层级和中文单文档流程。文档放置与验证使用 [dsh-doc-standards](../.agents/skills/dsh-doc-standards/SKILL.md)，内容覆盖与编辑判断使用 [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md)；设计依据由 [doc-tiers Agent Note](../.agents/notes/implemented/process/2026-07-04-doc-tiers-and-budgets.md) 持有。

## 文档结构

这些规则适用于面向人的文档；[Agent Notes](../.agents/notes/README.md) 使用自己的格式。[事故复盘](postmortem/README.md) 是限定到单次事故的参考文档，其时间顺序用于记录证据，而不是教学步骤。文档在目录树中的位置决定范围：完整说明自身主题，只用职责、用途和高层行为概括直属子项，更深细节链接到所属后代文档。文档类型不会扩大范围；参考文档只能穷举自身主题。测试机制、fixture 和 harness 应放在最低层的所属文档中，上层只链接。

每篇适用文档都归为教程或参考。教程按顺序带读者得到可观察结果，只在需要时引入概念；参考文档在明确范围内支持查找，不要求顺序阅读。两种形式都占较大篇幅时拆分；次要形式很短时用清晰章节标示。

写教程前，在内部判断读者起点以及各概念属于初级、中级还是高级。先建立前置知识，再引入依赖概念，逐步提高难度，把非必需的高级内容移到后续教程或参考文档。

按以下顺序写作：确定文档在目录树中的位置；限定允许的细节；选择教程或参考形式；教程按前置关系与难度排序；迁移属于后代文档的细节；用指向所属文档的链接替代下层解释。

## 文档层级：一个事实只有一个归属

| 层级 | 职责 | 不应包含 |
|---|---|---|
| 根目录 `AGENTS.md` | 每次会话都要进入上下文的常驻规则；每条一至三行并链接到所属说明 | 故事、长示例、情境化步骤、对链接内容的重复 |
| 子目录 `AGENTS.md`（`packages/`、`examples/`、`docs/`、`.agents/notes/`） | 仅适用于该子树的指令 | 根文件已承载的仓库级规则 |
| [architecture.md](architecture.md) | 有序架构地图：组合方式、核心包、循环、能力 seam 和扩展点 | 类型定义、逐包细节、决策依据、实现状态标记 |
| [subsystems/](subsystems/README.md) | 每个子系统一份参考页：类型、语义和生成的 Cordis API | 高层行为叙述 |
| [Agent Notes](../.agents/notes/README.md) | 活跃决策记录：原因、放弃的方案和必要验证；`implemented/` 描述已交付现实 | 迁移计划、验收任务清单、fixture 走读和已交付后的规格语气；归档记录不是当前权威 |
| [postmortem/](postmortem/README.md) | 事故叙事；唯一允许 war story 的层级 | — |
| [cookbook/](cookbook/adding-a-package.md) | 带编号验证步骤的操作指南 | 设计依据 |
| [user/](user/index.md) | 文档站发布的产品使用指南 | 生成参考表、贡献者流程、决策历史 |
| 包 README | 单包契约：配置、语义、限制、扩展点和 [Model Experience](cookbook/adding-a-package.md#4-write-the-package-readme) | JSDoc 重述、生成目录重述、其他包的职责 |
| [development.md](development.md) | 贡献者环境、日常流程和 CI 摘要 | 运行时或版本依据、会随 `package.json` 漂移的检查清单 |
| 生成参考：子系统页内 `cordis-surface` 区域、[Cordis core API](cordis-api/context.md)、[tool-catalog](tool-catalog.md)、[config-catalog](config-catalog.md)、[persistence-catalog](persistence-catalog.md)、[module-graph.md](module-graph.md) | 由生成器与新鲜度门禁持有的穷举资料；输出语言由生成器决定 | 手工编辑生成源或生成区域 |
| Skills（`.agents/skills/`） | 可复用工作流和专门判断标准 | 产品与运行时契约 |

放置规则：缺陷事件写复盘；决策依据写 Agent Note；步骤写 cookbook；类型定义写 subsystem；包契约写 README；常驻命令写根 `AGENTS.md` 并链接理由。

<a id="writing-rules"></a>

## 写作规则

- **中文单文档。** 普通文档只维护无语言后缀的中文 `.md`：没有英文对侧文件、没有 `.i18n.yaml` 记录、没有语言切换行。完全由生成器写出的参考文档保持生成器自身的语言，不手工翻译，也不为其建立对侧；产品 UI、locale 字典与系统 i18n 不受此规则影响。
- **记录当前状态，不叙述变更历史。** 避免在持久文档中写「以前／现在／不再」、PR、commit 或 stack 位置；直接陈述当前事实。变更故事只属于 commit、PR 或事故复盘。
- **改到哪个包，就更新那个包的文档。** 包 README 和所属 subsystem 页随行为一起改；只有确实影响其他包或用户可见行为时才动上层文档。
- **每段一个物理行。** 一个段落写成一行，折行交给编辑器 soft-wrap；代码块、表格和列表保留自身结构，代码注释遵守 linter 行宽。
- **带 `ts` 标记的围栏必须可编译。** 原样类型声明和其 JSDoc 使用 ` ```ts type-equiv `，去掉方法体的公开类声明使用 ` ```ts public-api `；两类围栏只用于逐字记录源码，声明变化时同步更新粘贴内容。
- **重塑已记录类型时同步更新所属 subsystem 页面。** 类型写在声明包所属组的页面；粘贴内容是否与源码一致由评审判断，没有自动检查。
- **注释和 JSDoc 记录完整契约，不记录推理过程。** 保留行为、失败、时序、所有权、强度、例外、后果和必要定位；删除控制流复述、测试走读、评审分析和代码重述。具体判断使用 [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md)。
- 直接点名行为主体和事实；`seam` 只用于仓库定义的完整能力。优先写确切检查、类型、API、操作或行为，不用比喻性的「门禁」「词汇」「表面」替代事实。
- 能与功能实现解耦的文档编写、迁移或大段编辑优先作为独立子任务委派；主任务给出范围、真源和验收命令，并负责核对最终 diff。

<a id="document-size"></a>

## 文档规模

常驻文档（根 `AGENTS.md`、[architecture.md](architecture.md)、各子树 `AGENTS.md`、包 README）保持精简：只写每次会话都需要进入上下文的规则和契约，其余内容下放到所属文档并留一行链接。没有字数门禁；判断标准是这些文档能否一次读完，读不完就说明内容放错了层级。

<a id="the-slop-checklist"></a>

## 冗余检查清单

- 同一规则出现在多个归属位置。搜索独特短语，只保留一个真源，其他位置改为链接。
- 变更历史或 war story：「以前」「现在」「不再」「曾经」「改名」「已移动」、PR 或 commit。改写为当前事实，必要时链接 Agent Note 或复盘。
- 文本或图中的实现状态标记。状态会腐烂，应由仓库结构和 package manifest 表达。
- 手写目录、JSDoc、测试／包／状态清单，而源码或生成器已经是权威。
- 推理过程：逐步实现叙述、显然分支的证明、测试走读或局部替代方案讨论。只保留结果契约或持久理由。
- 同一理由重复写在多个相邻方法旁，而不是写在所属能力或 helper。
- 一个段落承载多个规则和括号旁注。拆段或把细节下放到所属文档。
- 过度强调。只强调会改变行为的条款。
- `implemented/` Agent Note 使用提案语气。已交付记录描述现实，见 [implemented 指令](../.agents/notes/implemented/AGENTS.md)。

## 交叉引用必须使用可检查链接

仓库内引用使用相对 Markdown 链接，不写裸文件名或 Agent Note 编号。改路径或删文档时自己 grep 入站引用：链接目标、`#fragment` 锚点和代码注释里的 `docs/*.md` 路径都没有门禁兜底。
