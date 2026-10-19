# 来源与许可

本包移植自 [MIT 许可](LICENSE)的 [`omdsh-dev/dsh-genui`](https://github.com/omdsh-dev/dsh-genui)（Copyright (c) 2026 dsh-external，npm 包名 `@changfenhuang/dsh-genui`），并按本仓库约定改造：

- 拆分为宿主半（`src/plugin`：提示词段、工具、技能、资产路由）与浏览器半（`src/client`：DOM 围栏渲染、组件库、面板、工具行视图）同包双面，登记 Client aggregate。
- 对等包导入从 `@deepseek-ai/dsh-*` 改写为 `coding-*`；会话解析、文件链接、DiffBlock 标签等 API 差异按本仓库实际形态适配（见 README「适配说明」）。
- 会话类型导入改走 `coding-session/types` 子路径；`fence-feedback` 的消息来源收敛为本仓库 `MessageSource`。
- 懒引擎（mermaid／three／echarts）构建挂到共享 `clientBundle` preset 的 companions；独立 HTML 导出（standalone runtime）未随包移植。
- 上游测试按行为移植（`tests/`），持久化生命周期用例因依赖宿主 `SessionStore` 值导入放 `*.host.spec.ts`。

上游原样保留的部分继续适用其 MIT 条款，见同目录 [LICENSE](LICENSE)。
