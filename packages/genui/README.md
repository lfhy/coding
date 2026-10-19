# genui/ — 生成式 UI 家族

本家族把模型回答中的 ` ```dsh-ui ` 围栏变成可交互界面，并提供工具通道与会话面板。

| 包 | 职责 | ctx key |
|---|---|---|
| [`genui/`](genui/README.md) | `dsh-ui` 围栏语言与白名单组件渲染器、`render_ui`/`validate_dsh_ui` 工具、bundled `genui` 技能、同回合围栏修正、会话面板 dock 与懒引擎资产路由 | 宿主半注入 `systemPrompt`/`tools`/`skills`/`webServer`；浏览器半注入 `slots`/`sessions` |
