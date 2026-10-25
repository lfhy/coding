# 逆向分析模式：资料来源与许可

本 preset 的两块外来内容分开说明，两者许可不同。

## REA（Reverse Engineer Anything）

- 上游：https://github.com/morluto/rea （MIT，另见 https://rea.tools/ ）
- 本 preset 的接入方式：`agent.cordis.yml` 用 `coding-mcp-client` 行以 `npx -y rea-agents@6.7.0 mcp` 启动官方 MCP 服务器，不内嵌、不修改其代码；工具名由客户端按 `mcp__rea__<原始名称>` 生成。
- `skills/rea-tool-workflow/SKILL.md` 与 `skills/native-binary-analysis/SKILL.md` 的目标路由、证据分页、provider 前提与恢复阶梯，改写自 REA 仓库内随包分发的 `reverse-engineer-anything` 技能（同一 MIT 许可），并按本模式的工具接入方式重写为中文，未保留其上游提示词原文。
- 版本约定：本 preset 固定 `rea-agents@6.7.0`，因为随附技能正文按该版本的工具面编写（发布包的 207 个工具名已逐个核对，正文只引用其中存在的名称）。升级时同时修改 `agent.cordis.yml` 中非 Windows 与 Windows 两行的版本号，并核对 `rea-tool-workflow` 的工具路由表。

## REA-Prompts（REAP）

- 上游：https://github.com/JoasASantos/REA-Prompts
- 该仓库是 REA 的调查提示词合集，仓库内未附带许可证文件，因此其中文本**未被复制**。
- 本 preset 的其余技能按它归纳的调查主题组织（安装与连接、功能追踪、原生二进制、行为克隆、游戏与 WASM 移植、固件、Android、内核、漏洞研究、Electron/JavaScript、保护与反作弊、版本对比、长任务），正文为本项目按各主题重新撰写的中文方法说明，措辞与示例均为原创。
- 若上游日后补充许可证，可在评审后替换为原文档的直译版本，并在此更新归属。
