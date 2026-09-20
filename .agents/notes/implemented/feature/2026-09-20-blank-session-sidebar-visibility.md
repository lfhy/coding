# Agent Note: 空白会话不进入侧边栏会话树

Status: implemented

## 问题

New Session 进入的是一个已经物化、但日志里还没有任何轮次的 Host 会话，它的 `blank` 位由 [Web client session scope and provide channel](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md) 持有。侧边栏会话树把这个会话当成一条普通行渲染，于是点击顶部 New Session 和 Workspace 行的 ＋ 都会在目标 Workspace 分组下多出一条被选中的「新会话」行。这一行没有可展示的内容：没有时间标签，没有行菜单，悬浮卡片没有时间，也复制不出标题。用户点的是「新会话」，不是列表里凭空多出的一个占位条目。

## 决策

空白会话（`SessionSummary.blank`）不作为行进入侧边栏会话树，分组与单列表共用同一可见投影：`sessionVisible` 只要求会话不是 subagent 派生、未被归档且非 blank。顶部 New Session 与 Workspace 行的 ＋ 仍复用或创建该 Workspace 的空白会话；该 Workspace 分组下不会出现对应的列表行，当前会话的归属由 `containsCurrent` 高亮表达。`SessionNode.blank`、`Rows.tsx` 针对空白行的特例，以及 ui-workspace locale 的 `session.new` 文案随之删除，行的重命名、fork、归档和悬浮卡片不再区分空白会话。

空白会话仍是真实的 Host 会话：它按 Workspace 复用，内容搜索排除它，用户继续在会话页的空态 Hero（本包填入 `conversation.hero.workspace` 选择器的那块界面）里开始第一次输入。

## 曾考虑的替代方案

**保留该行，只去掉选中态。** 拒绝：空白会话没有标题、时间或行菜单可展示，这条行仍是占位，继续占着一个真实会话在该分组里的位置。

**只在启动恢复阶段隐藏。** 拒绝：可见性由会话是否已经开跑决定，与会话何时进入页面无关；按启动路径分支会让同一个会话在首条提示词前后走两条不同的渲染路径。

**把空白会话做成客户端草稿实体，不进 Host 会话列表。** 拒绝：空白会话是已经物化的 Host 会话，按 Workspace 复用、首条提示词提交与失败重试都依赖它的 SessionId；改成客户端草稿要重写物化、复用与重连对齐，还会让 [Workspace UI Complete Product Flow](2026-07-25-workspace-ui-product-flow.md) 里以对象身份为中心的首条发送流水线失去对象。

## 后果

侧边栏不为一次新会话凭空多出一条条目，Workspace 分组靠 `containsCurrent` 表达当前会话的归属，分组计数只统计真实会话行。代价是进入新会话时列表没有即时反馈，信号只有工作区分组的高亮与右侧 Hero 空态。从 Workspace 行新建会话仍会先展开该分组，使首条提示词落地后的新行直接落在展开的分组内。空白会话按 Workspace 复用、搜索排除空白会话、Hero 空态这三项行为不变。

## 测试

- `packages/client/ui-workspace/tests/tree.client.spec.ts`：分组与单列表的派生结果都不含空白会话，`sessionCount` 只统计真实会话，`containsCurrent` 仍标出包含当前会话的分组。
- `packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx`：渲染出的树里没有「新会话」行，搜索按任何查询都不命中空白会话，切换分组方式不改变结论。
- `apps/web/tests/snapshots/lifecycle-chrome/hero.expected.md` 等 GUI e2e 快照：空态侧边栏不含被选中的 New Session 树项。

## 相关记录

New Session 的复用与首条发送流程由 [Workspace UI Complete Product Flow](2026-07-25-workspace-ui-product-flow.md) 持有，该记录已按本条决策更新空白会话的可见性描述。本条部分取代 [Web client session scope and provide channel](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md) 关于侧边栏可见投影的结论，两份记录都保持活跃。
