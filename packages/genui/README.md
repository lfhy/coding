# genui/ — 生成式 UI 家族

本家族把模型回答中的 ` ```gen-ui ` 围栏变成可交互界面，兼容旧 `dsh-ui` 围栏，并提供工具通道。

| 包 | 职责 | ctx key |
|---|---|---|
| [`genui/`](genui/README.md) | `gen-ui` 围栏语言与白名单组件渲染器（兼容旧 `dsh-ui`）、`render_ui`/`validate_gen_ui` 工具、bundled `genui` 技能、同回合围栏修正与懒引擎资产路由 | 宿主半注入 `systemPrompt`/`tools`/`skills`/`webServer`；浏览器半注入 `slots`/`sessions` |
