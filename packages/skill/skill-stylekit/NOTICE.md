# 来源与许可

本包随附的视觉风格目录与技能正文改编自 [MIT 许可](LICENSE)的 [StyleKit](https://github.com/AnxForever/stylekit)（Copyright (c) 2026 AnxForever），以及其 Agent Skill 仓库 [`AnxForever/stylekit-skill`](https://github.com/AnxForever/stylekit-skill)。上游原样保留的部分继续适用其 MIT 条款，许可证全文见同目录 [LICENSE](LICENSE)。

按本仓库约定改造的部分：

- **只固化目录层**：`assets/styles.jsonl` 是上游公开接口 `https://www.stylekit.top/api/styles` 的快照，保留 `slug`、中英文名称、分类、标签、配色、关键词与一句话说明；设计令牌、组件配方、`globalCss` 与增量变更日志不上车，仍由技能在线取用，避免把约 5 MB 的站点数据塞进发行包。
- **正文重写**：`assets/stylekit.md` 按本仓库的技能形态重写，去掉了上游 skill 自带的 Python 脚本、自动更新机制与评估脚本，改为「随包目录检索 → 在线取完整规格 → 在现有技术栈内落地 → 用 `browser-use` 验收」的路径，并补充与 `frontend-development` 技能的分工。
- **生成可复现**：资产由 [`scripts/gen-stylekit-catalog.ts`](../../../scripts/gen-stylekit-catalog.ts) 生成，`pnpm run gen-stylekit-catalog` 重新拉取上游目录，`pnpm run verify-stylekit-catalog` 离线校验已提交资产的结构与顺序。

上游没有随本包移植的内容：站点、CLI、MCP 服务、预览图片与模板；需要它们时按上游文档单独安装，本包不代替其安装步骤。
