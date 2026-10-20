# coding-genui

内嵌 GenUI 能力：把模型回答中的 ` ```gen-ui ` 围栏渲染成可交互组件，并提供 `render_ui`／`validate_dsh_ui` 模型工具与 `genui` 技能。历史 `dsh-ui` 围栏继续可用。界面只出现在回答正文或工具行，不注册面板 dock 与 `/panel` 命令；历史 `panel`/`append` 字段不改变显示位置。

围栏正文开始到达后，在原代码块位置显示居中的“正在生成界面…”与加载动画，不展示语言标签或半截 JSON。每个完整组件对象闭合后立即显示，无需等待整条回复结束。停止或定稿后无法渲染的正文恢复为可复制代码块并显示诊断；减少动态效果偏好会停用动画但保留状态提示。

移植自 MIT 许可的 [`omdsh-dev/dsh-genui`](https://github.com/omdsh-dev/dsh-genui)（Copyright (c) 2026 dsh-external），来源与改造说明见 [NOTICE.md](NOTICE.md)；组件 JSON 语法见 [SKILL.md](SKILL.md)。

## 组成

| 部分 | 职责 |
| --- | --- |
| `src/plugin/index.ts` | 系统提示词段 `genui:fence`（order 120）、bundled `genui` 技能、webServer 资产路由 `/plugins/coding-genui/assets/*` |
| `src/plugin/tool.ts` | `render_ui`（工具行卡片，meta 投影携带修复后 spec）与 `validate_dsh_ui`（发围栏前预检） |
| `src/plugin/fence-feedback.ts` | 同回合围栏修正：`agent/turn-stopping` 边界上经 `agent.steer()` 注入 plugin notice，每回合/每指纹至多一次，子代理不触发；`llm/stream` waterfall 把已验证 GenUI 回合的 reasoning-only 停止改写为 `EMPTY_RESPONSE` 交宿主重试 |
| `src/client/dom-fence.ts` | DOM 渲染通道：观察会话 DOM，识别 `gen-ui` 围栏（`md-code-block` 表面 + label+pre 结构兜底），流式逐组件接管，settle 后按 `data-chat-anchor-key` 稳定身份 |
| `src/client/blocks/` | 白名单组件库（30+ 类型：布局、表格、图表、表单、测验、mermaid/diagram/scene3d） |
| `lib/assets/*.js` | mermaid／three／echarts 懒引擎 IIFE，首次使用时经资产路由注入 |

## 配置

```yaml
- id: genui-client
  name: 'coding-genui'
  config:
    fenceFeedback: false   # 关闭同回合围栏修正（默认开启）
    renderUiTool: false    # 不注册 render_ui 工具（默认注册）
```

## 适配说明（相对上游）

- 会话解析：`sessions.retainInfo` 不存在，改用 `sessions.list` 快照的 `current`；chat 快照经 `sessions.binding(id).session`（本身是会话快照 Observable）读取。
- 文件链接：`sidebarRight.openResource` 改为 `openFileForSession`（右侧工作台文件标签），行号参数暂不透传。
- DiffBlock 不接收 labels（本仓库原语内置中文文案）；JsonTree/CodeBlock 标签经 `primitive-labels.ts` 本地化。
- `fence-feedback` 的消息来源收敛为本仓库 `MessageSource`（`kind:'plugin'` + notice form），Session format v4 双分支已删。
- 会话类型导入走 `coding-session/types` 子路径（浏览器安全面）；宿主侧消费的 `Session`／`SessionStore` 以最小结构面声明在 `fence-feedback.ts`。
- 懒引擎构建挂在共享 `clientBundle` preset 的 companions 上；独立 HTML 导出（standalone runtime）未随包移植。

## Model Experience

### Request context and condition

#### What the model sees

系统提示词常驻 `genui:fence` 段（围栏语法、类型白名单、行为规则），bundled `genui` 技能携带完整组件→字段映射，`render_ui`／`validate_dsh_ui` 工具 schema 见[工具目录](../../docs/tool-catalog.md)。

#### Token effect

`genui:fence` 段为固定追加；技能正文按加载计入；两个工具 schema 常驻工具清单。

#### KV Cache effect

提示词段与工具 schema 在会话内前缀稳定，不使缓存失效；同回合围栏修正以 plugin notice 追加，保持追加式增长。

## Known Limitations and Deferred Work

- **独立 HTML 导出未移植**：上游 `Export → HTML` 依赖 standalone runtime 构型（嵌入渲染器 + KaTeX 字体），本包未包含；导出入口在浏览器半保持禁用态。
- **文件链接不带行号**：工作台文件标签 API 无行参数，`line` 暂被忽略。
