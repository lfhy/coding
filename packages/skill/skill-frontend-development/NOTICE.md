# 来源与许可

本包随 `frontend-development` 技能分发的视觉风格目录与规格，改编自 [MIT 许可](LICENSE)的 [StyleKit](https://github.com/AnxForever/stylekit)（Copyright (c) 2026 AnxForever），以及其 Agent Skill 仓库 [`AnxForever/stylekit-skill`](https://github.com/AnxForever/stylekit-skill)。上游原样保留的部分继续适用其 MIT 条款，许可证全文见同目录 [LICENSE](LICENSE)。

资产位置是 `assets/stylekit/`，由 `assets/frontend-development.md` 的「Pick a named visual direction」一节按需读取；风格目录不再作为独立技能条目出现在技能目录里。

按本仓库约定改造的部分：

- **固化目录与完整规格**：`assets/stylekit/styles.jsonl` 是上游公开接口 `https://www.stylekit.top/api/styles` 的目录快照（`slug`、中英文名称、分类、标签、配色、关键词、一句话说明）；`assets/stylekit/styles/<slug>.json` 是每个风格在 `/api/styles/<slug>` 的规格快照，保留 `philosophy`、`doList`／`dontList`、`aiRules`、`colors`、`tokens`、`recipes`、`components`、`examplePrompts` 与 `globalCss`，让技能离线可用。站点自用的质量看板（`readiness`、`accessibility`、`changelog`、`version`）与封面图地址不上车。
- **正文并入前端技能**：上游 skill 自带的正文、Python 脚本、自动更新机制与评估脚本都没有保留；「先按关键词定位风格 → 读取随包完整规格 → 在现有技术栈与主题层落地 → 用 `browser-use` 验收」这条路径改写为前端技能里的一个流程步骤，与信息架构、组件复用和验收规则共用同一套约束。
- **生成可复现**：资产由 [`scripts/gen-stylekit-catalog.ts`](../../../scripts/gen-stylekit-catalog.ts) 生成，`pnpm run gen-stylekit-catalog` 重新拉取上游目录与规格，`pnpm run verify-stylekit-catalog` 离线校验已提交资产的结构、顺序与规格对应关系。

上游没有随本包移植的内容：站点、CLI、MCP 服务、预览图片与模板；需要它们时按上游文档单独安装，本包不代替其安装步骤。
