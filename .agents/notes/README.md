# Agent Notes

Agent Note 是记录影响代码库的决策或提案的设计文档，保存代码与普通文档无法承载的原因、被放弃的方案和后果。本文件规定存放位置、何时需要记录，以及[文件格式](#the-file-format)。

## 布局与命名

每份 Agent Note 的路径为 `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`，其中包含两个维度：

- **生命周期**是顶层目录：
  - `proposed/`：实施前评审、尚未完成的提案。
  - `implemented/`：已经交付的决策。路径、符号、默认值或机制后来变化时，在同一变更中更新事实，但不把原决策改写成另一项决策。见 [implemented/AGENTS.md](implemented/AGENTS.md)。
  - `rejected/`：经过讨论后被否决的提案。只有其理由仍能防止一种现实且诱人的错误时才保留，否则删除整份记录及其 legacy pair 产物。
- **类别**是第二级目录，使用下方封闭集合。

文件名日期是主题首次提出的日期，以 git 历史为准。Agent Note 之间使用相对 Markdown 链接，不用裸编号或纯文本引用。活跃生命周期目录树本身就是清单；禁止新增集中式 `INDEX.md`，原因见[不设索引决策](implemented/process/2026-07-19-remove-generated-agent-note-index.md)。未来决策价值较低的 implemented 记录移入冻结的 [`archived/`](archived/AGENTS.md)。

<a id="classification"></a>

## 分类

`scripts/agent-note-tree.ts` 定义封闭的类别集合；新增类别必须同时修改该集合与本节。

| 类别 | 覆盖范围 |
|---|---|
| `feature` | 面向用户或模型的新能力。 |
| `bug-fix` | 修正缺陷或弥补事故复盘发现的缺口。 |
| `simplification` | 在不增加能力的前提下移除代码、行为或对外范围。 |
| `architecture` | 关于交付源码的结构决策，例如包关系与运行时概念。 |
| `process` | 代码周边的工具、政策或工作流，例如门禁、包管理和 vendoring。 |
| `testing` | 测试基础设施与策略。 |

`architecture` 关乎交付源码，`process` 关乎源码周边流程。`refactor` 不单列，因为它与 `simplification` 重叠，是否改变可观察行为已经足以区分。

## 语言与 legacy pair

新增 Agent Note 只创建无语言后缀的中文 `.md`，不创建 `.zh.md` 或 `.i18n.yaml`。机器字段 `# Agent Note: ` 与 `Status:` 保持固定英文 token，标题和正文使用中文。

未触及的历史英文／中文／伴随记录三件套可以继续保留，并由[历史配对门禁](../../docs/i18n/README.md)验证。实质修改普通历史记录时，默认将 `.zh.md` 内容迁入无后缀文件并删除另外两个产物；明确需要保留配对时才继续同步两侧和伴随记录。产品 locale 与系统 i18n 不适用本规则。

## 归档与删除

当 implemented Agent Note 的决策已经完整落地，且其理由不太可能再指导未来工作时归档；若备选方案、归属边界、否定性保证、持久化或 wire 语义、安全规则、重新引入条件仍有价值，则保持活跃。proposed 记录不能归档：不再推进时转为 rejected。rejected 记录只在仍能防止现实错误时保留。使用 [dsh-archive-agent-notes](../skills/dsh-archive-agent-notes/SKILL.md) 进行判断，不按字数、年龄或配额处理。

归档路径为 `archived/{class}/yyyy-mm-dd-topic-title.md`。中文单文档归档时只移动 `foo.md`，在 `Status: implemented` 后插入 `Archived: YYYY-MM-DD`；历史三件套仍整体移动，在两侧插入同一日期并重新记录 sidecar。两种形态都要修复或删除入站链接，再由 `verify-archived-agent-notes --write` 追加封存 hash。

封存后的文件永久冻结，不得编辑、翻译、重排、更新、移动或删除，也不是当前行为的权威。文档门禁跳过归档文件的出站链接；活跃文档只有在确实引用历史时才链接进去。[归档政策 Agent Note](implemented/process/2026-07-26-frozen-agent-note-archive.md) 保存设计依据。

<a id="when-to-write-one"></a>

## 何时需要写一份

每个非平凡变更必须在同一 PR 中新增或更新至少一份 Agent Note。修改行为、架构、跨文件或跨包约定、流程或工具、测试策略、磁盘／wire／配置格式，或任何维护者可能合理重新审视的决策，都属于非平凡变更。重大未来工作从 `proposed/` 开始；已经做出的决策从 `implemented/` 开始，并选择与决策匹配的类别。

更新已经持有该决策的记录即可，不要创建重复记录。纯机械或局部、且不改变行为、约定、结构、流程或理由的编辑可以豁免。Agent Note 不得被编辑成另一项决策；用新记录取代旧记录，并让两者互相链接，除非旧记录按下方规则被完整合并。跟踪现有决策的路径、名称和结构变化属于必要事实更新。

完全被取代的 implemented Agent Note 可以合并进当前持有记录后删除。新 owner 必须保留旧记录独有的理由、替代方案、后果、必要验证和明确覆盖缺口，并修复所有入站链接；删除时同时移除该记录的所有 legacy pair 产物。部分取代不符合合并条件，两个记录都保留并交叉链接。

功能新增记录只有在该功能已从生产代码、配置、schema、持久化或 wire 格式、迁移与兼容行为中彻底消失，当前文档不再宣称可用，且没有测试把它当作受支持行为时，才能合并到后续移除记录。移除 owner 必须保留最初动机、动机为何不再成立、完全移除之外的方案、放弃的能力、重新引入条件和证明彻底移除的验证。仅移除某个传输、默认值、实现或展示属于部分取代。

<a id="the-file-format"></a>

## 文件格式

每份活跃 Agent Note 使用统一格式，由 `pnpm run verify-agent-note-format` 强制执行；设计依据见[统一格式决策](implemented/process/2026-07-05-uniform-agent-note-format.md)。历史英文 canonical 继续使用英文章节名，新的中文 canonical 使用下方中文章节名；一份文件内不能混用两套必需章节。

### 头部块

前三行严格为：

```markdown
# Agent Note: <中文标题>

Status: <status>
```

随后是一个空行。`Status:` 必须与生命周期目录一致：

- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <一行原因>`

状态行不写日期或括号说明。文件名记录首次提出日期，git 记录其余历史；「以修订形式接受」写在正文。只有 rejected 状态在状态行携带理由。

### 正文骨架

每份中文 Agent Note 以 `## 问题` 开始，使动机脱离解决方案也能成立。真正独特的技术章节可放在必需章节之间。

#### `proposed/`

```markdown
## 问题
## 提案
…自定义章节…
## 曾考虑的替代方案
## 验收标准
## 风险
```

`## 提案` 可以使用将来时，包含计划、迁移步骤和开放问题；`## 验收标准` 说明完成的可观察状态；`## 风险` 同时记录失败风险与主动放弃的内容。

#### `implemented/`

```markdown
## 问题
## 决策
…自定义章节…
## 曾考虑的替代方案
## 后果
```

`## 决策` 用现在时描述已交付现实；`## 后果` 同时记录代价与收益。implemented 记录禁止 `## 提案`、`## 计划`、`## 迁移计划` 与 `## 验收标准`。描述当前证据的 `## 测试`、`## 延后工作` 或 `## 相关记录` 可以存在。

#### `rejected/`

rejected Agent Note 冻结提案内容，结论位于 `Status:` 行。仍强制要求头部块、`## 问题` 开头、`## 提案` 和下方替代方案章节；提案阶段已有的计划、验收标准与风险可以保留。

### 曾考虑的替代方案

每份 Agent Note 必须有 `## 曾考虑的替代方案`，每个真实方案及其落选原因使用一个加粗引导段落，或使用 `### 为什么不采用 <X>？` 子节。不得为了满足格式凭空编造方案。

2026-07-05 之前且无法从记录重建替代方案的旧英文 Agent Note，可以使用以下精确注释代替章节；其他文件不得使用：

```markdown
<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
```

### 生命周期迁移

生命周期目录变化时，同一变更必须更新 `Status:` 并满足目标骨架。`proposed/` → `implemented/` 把 `## 提案` 改写为现在时的 `## 决策`，将验收标准与风险折入 `## 后果` 或当前验证章节，并删除计划语气。`proposed/` → `rejected/` 只在状态行写入拒绝原因并冻结提案。
