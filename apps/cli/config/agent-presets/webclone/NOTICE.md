# 网页复刻模式：资料来源与许可

## ai-website-cloner-template

- 上游：https://github.com/JCodesMore/ai-website-cloner-template （MIT，Copyright (c) 2025 JCodesMore）
- 本 preset 改写了上游随包分发的 `clone-website` 技能，以及它的两份参考文档 `references/inspection-guide.md`、`references/framer-and-motion.md`，分别落在本目录的三份技能里：
  - `skills/clone-website/SKILL.md`（四步流程与交付要求）
  - `skills/website-inspection/SKILL.md`（页面结构、资产与状态证据的采集方法）
  - `skills/framer-and-motion/SKILL.md`（Framer 页面与动效的检查与验证）
- 改写范围：正文重写为简体中文，并把上游假定的 Claude Code／Codex 调用方式、Next.js + shadcn 固定模板、以及上游自带的资产下载工具，替换为本产品实际具备的 `browser_*` 工具面、技能目录约定与按 `project-init` 技能选型的工程；四步流程（map／observe／build／compare）与「真实内容与真实资产」的原则沿用上游。
- 未复制上游的模板代码（`src/`、`public/`、依赖清单、Docker 与 CI 配置）。需要该模板作新工程地基时，由 Agent 按 `project-init` 技能单独克隆并去掉 origin，不随本 preset 分发。

## 与本仓其它部分的关系

- 本模式复用标准模式的行与工具面，只额外挂一个指向自带 `skills/` 目录的 `coding-skill-filesystem` 行；不注册任何 MCP 服务器，也不改动宿主组合。
- 上手流程、工具策略与登录续期的规则写在 `agent.cordis.yml` 的 persona 里；技能正文按需加载，因此不依赖技能成立的约定都写在提示词中。
