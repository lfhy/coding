# Coding

Coding 是面向个人开发的开源 AI 编程桌面客户端。它将模型对话、项目文件、终端、浏览器和 Git 工具集成在同一个窗口中，让你从描述需求到修改代码、运行验证，都能在桌面工作台内完成。

**开箱即用是项目的核心目标。** 桌面应用随附本地 Host 运行时、常用工具插件和按需加载的 Skills，不需要先搭建服务、逐项安装插件或自行拼装提示词。默认提供无需自行配置密钥的 Free 模型渠道，也可以接入自己的模型服务。

项目基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，使用 [Cordis](https://github.com/cordiverse/cordis) 组织插件。桌面应用是产品主线，Web、CLI 和 Linux 终端客户端作为补充入口复用运行时能力。

> 项目处于开发者预览阶段，功能、配置与数据格式可能发生不兼容变更。桌面端提供 macOS arm64 的源码构建入口，尚未提供可下载的安装包；Linux 与 Windows 的 Electron 原生运行尚未验收。

## 内置插件：不必从零组装 Agent

默认的“标准模式”已装配以下能力，常用功能无需额外寻找和安装插件。实际操作仍受会话权限、模型能力和服务可用性约束。

| 能力 | 可以直接做什么 |
| --- | --- |
| 编程工具链 | 读取、搜索和编辑项目文件，执行 Shell 命令、构建与测试，查看工具调用和结果。 |
| 桌面工作台 | 在同一窗口浏览文件树与内容预览、使用终端、查看 Git 变更和提交历史，管理工作区与会话。 |
| 浏览器与联网搜索 | 让 Agent 打开网页、交互、截图和验证本地开发页面；桌面浏览器中真人与 Agent 共用同一页面，无需另装 Chromium。默认 DuckDuckGo 搜索无需配置搜索密钥。 |
| 模型渠道 | 使用内置 Free / Auto 开始对话，也可在设置中添加自己的渠道、模型和凭据，切换模型与推理档位。 |
| 项目记忆 | 将用户偏好、项目约定和任务交接保存到仓库之外，在同一项目的新会话中载入摘要，减少重复说明。 |
| 长任务与协作 | 维护计划、待办和目标，运行后台命令、委派可继续的子代理，按需使用工作流；进度提醒帮助 Agent 在长任务中汇报进展。 |
| GenUI 交互回答 | 将回答中的数据与结论呈现为表格、图表、表单、流程图等可交互内容，而不只有纯文本。 |
| 主题外观 | 设置里的「主题外观」页内置 47 套配色，点卡片即换肤；还能换壁纸、指定强调色、调玻璃与面板不透明度，并导入/导出可分享的主题包。 |

操作方式见[界面指南](docs/user/guide/index.md)，项目记忆与交互回答的具体行为分别见[记忆说明](packages/memory/memory/README.md)和 [GenUI 说明](packages/genui/genui/README.md)。内置 GenUI 移植自 MIT 许可的 [omdsh-dev/dsh-genui](https://github.com/omdsh-dev/dsh-genui)，版权与改造范围见[来源说明](packages/genui/genui/NOTICE.md)。

内置主题同样随应用提供，不需要另外安装插件：幻梦 8 套、轴伊 2 套、OpenCode 调色板 37 套，分别移植自 MIT 许可的 [RevolutionLA/dsh-dream-skin](https://github.com/RevolutionLA/dsh-dream-skin)、[tpmoonchefryan/dsh-joi-channel-theme](https://github.com/tpmoonchefryan/dsh-joi-channel-theme) 与 [FeatherHunter/dsh-opencode-palette](https://github.com/FeatherHunter/dsh-opencode-palette)。来源版本、移植内容与未移植的能力见[主题来源说明](packages/client/ui-theme/NOTICE.md)，实现与限制见 [ui-theme 说明](packages/client/ui-theme/README.md)。

## 内置 Skills：让 Agent 按任务采用合适的做法

插件提供工具和界面，Skills 提供任务相关的工作指引。标准模式、PTC 模式、Codex 模式与逆向分析模式都提供同一组随包交付技能，正文按需加载，不必把所有技能一次性塞进对话；逆向分析模式另有 13 个逆向调查技能。以下技能随应用提供，不依赖当前项目是否配置了技能目录：

| Skill | 用途 |
| --- | --- |
| [`browser-use`](packages/skill/skill-browser-use/README.md) | 指导 Agent 先观察页面，再使用有效的元素引用操作网页，完成页面阅读、交互、截图和界面验收。 |
| [`frontend-development`](packages/skill/skill-frontend-development/README.md) | 指导前端实现遵循项目已有技术栈、组件和设计规范，使用图标与按需 CSS 动效配方；列表页固定在视口内、只在列表区域内部滚动，长列表用虚拟滚动与无限滚动加载；避免内部实现文案和文字海报，并结合浏览器检查实际效果。 |
| [`go-backend`](packages/skill/skill-go-backend/README.md) | 写 Go 服务端时给出布局（根 `main.go` 加 `cmd`／`conf`／`core`）、HTTP、context 与并发、错误包装、数据访问与交付验证的默认约定，前端放 `web/` 并由 `go:embed` 提供访问，优先沿用项目已有做法。 |
| [`project-init`](packages/skill/skill-project-init/README.md) | 在改动前定好地基与可回滚的版本基线：新项目能联网时先去 GitHub 找 template 或同类开源仓库（如 vben、shadcn-admin；对话与 Agent 页面用 assistant-ui、Cherry Studio 等）当地基、复用成熟实现而不重写基础件、后端按分层技能搭，再判断 Git 工作区、`git init`、忽略规则、逐条确认后建基线提交，并给出新项目最小的 README／AGENTS。 |
| [`genui`](packages/genui/genui/README.md) | 提供交互式回答的组件与语法指引，用于生成表格、图表、表单和流程图等内容。 |
| [`stylekit`](packages/skill/skill-stylekit/README.md) | 为界面选定具名视觉风格（玻璃拟态、新野兽派、赛博朋克、Apple／Stripe 风格等），给出配色、设计令牌与 do／don't 规则，并在项目现有技术栈内落地和验收。 |

你可以直接描述任务，让 Agent 按技能指引工作；也可以在输入框输入 `/` 查看技能候选，或在消息中写入 `/frontend-development`、`/browser-use`、`/stylekit`、`/genui` 显式调用。

自有规范也能接入：将技能放入项目的 `.agents/skills/<name>/SKILL.md`，或数据主目录的 `skills/<name>/SKILL.md`，即可由本地技能发现机制读取。格式、发现范围与优先级见[本地 Skills 说明](packages/skill/skill-filesystem/README.md)。本仓库还随源码提供 [Go 项目约定](.agents/skills/go-project-conventions/SKILL.md)、[CLI 配置](.agents/skills/go-cli-config/SKILL.md)、[数据库](.agents/skills/go-database/SKILL.md)与[质量检查](.agents/skills/go-quality/SKILL.md)等项目级技能，供在本仓库开发时使用；它们不属于安装版面向所有项目的内置技能。

## 逆向分析模式：只在需要时接入 REA

在会话的模式选择里切到「逆向分析模式」后，这个会话才获得 [REA（Reverse Engineer Anything）](https://github.com/morluto/rea) 提供的 `mcp__rea__*` 工具：原生二进制的反汇编与反编译、安装包与固件拆解、JavaScript／Electron 与 Android 分析、版本对比、崩溃记录与运行时观测。其它模式不注册这些工具，也不为本模式以外的会话启动该服务。

该模式的系统提示词按分析任务单独编写：沿用通用约定「每步改动都可回滚」的目的，把分析会话做成可撤回的操作——目标只读并先记哈希、只在副本上操作，分析目录不在 Git 工作区内时先 `git init`、检查忽略规则并建基线提交，运行目标或附加调试器前先说明副作用与恢复方式，只有你要求实现时才回到常规的提交节奏。它还要求先列问题清单与证据台账、大目标摘要优先、收尾关闭原生会话并导出证据。它随附一组按需加载的逆向调查技能，与模式目录一起分发：`reverse-engineering`（授权边界、调查计划与证据台账）、`rea-tool-workflow`（工具路由、证据分页、引擎缺失时的恢复路径），以及按目标类型划分的 `feature-tracing`、`native-binary-analysis`、`javascript-electron-analysis`、`android-apk-analysis`、`firmware-embedded-analysis`、`kernel-driver-analysis`、`vulnerability-research`、`protection-research`、`clean-room-cloning`、`game-analysis` 与 `version-comparison`。

使用前提：本机有 Node.js 与 npm，且版本满足 REA 的要求（Node 22.23.4+、24.22.1+ 或 26.12.1+）；首次切入该模式时 `npx` 会下载固定版本的 `rea-agents` 包，需要联网。原生分析使用本机已安装的 Hopper、Ghidra 或 IDA，Android 分析需要自备 JADX 与 Java，纯静态的 JavaScript／Electron 分析不需要引擎。引擎缺失时只有依赖它的调用失败，Agent 会按技能里的恢复路径诊断，其余工具照常可用。

这个模式的适用边界是授权：只分析你自己拥有、或你明确获授权测试的软件。来源归属见[模式来源说明](apps/cli/config/agent-presets/reverse/NOTICE.md)，操作与排错见[界面指南](docs/user/guide/index.md#逆向分析模式)。

## 快速开始：桌面应用

在 macOS arm64 的原生终端中构建并打开应用。若系统缺少 Git 或 `make`，先运行 `xcode-select --install` 并完成 Xcode 命令行工具安装。

```sh
git clone https://github.com/lfhy/coding.git
cd coding
make build
open dist/Coding.app
```

`make build` 会检查并补齐构建工具、安装锁定依赖，然后生成 `dist/Coding.app`。应用包含独立 Node Host 和 Electron 浏览器，运行时无需单独安装 Node、Chromium 或手动启动 Web 服务；构建本身不会替换系统应用目录中的已有应用。

如需安装到系统应用目录，可在仓库根目录执行：

```sh
make install
```

**`make install` 会重新构建并替换 `/Applications/Coding.app` 中的已有应用。** 本机包仅做 ad-hoc 签名，未经 Apple 公证，复制到其他机器后可能被 Gatekeeper 阻止。工具要求、安装行为与限制见[桌面安装指南](docs/user/guide/install.md#macos-桌面应用)。

### 打开后就可以开始任务

1. **选择项目**：打开本地文件夹，或选择“不在项目中工作”创建会话；需要远程开发时，可从桌面界面的“远程连接”进入 SSH 工作区。
2. **确认模型**：新配置默认使用 Free 渠道的 Auto，无需自行配置密钥。需要自己的服务时，在“设置 → 模型”中添加渠道和模型；详见[模型配置指南](docs/user/guide/providers.md)。
3. **描述需求**：例如“按项目现有风格实现一个设置页，启动开发服务并用浏览器验证”。Agent 可以结合内置工具与 Skills 推进任务，遇到审批或必要选择时再询问你；完成后检查变更和验证结果。

Free 依赖第三方免费服务，可能受到地区限制、限流或上游故障影响，不保证始终可用。Auto 只在候选模型尚未开始回复时尝试故障转移，规则与排错见[Free 渠道说明](docs/user/guide/providers.md#内置渠道free)。

## 桌面端开发

在已有源码检出的仓库根目录准备工具和依赖，再启动独立的 Electron 开发实例：

```sh
make toolkit
pnpm install --frozen-lockfile
make dev
```

`make dev` 会构建 Host、Client、Web、远端 agent 资源和桌面壳，再启动应用。开发实例使用独立的 `~/.dsh-electron-dev`，不读取安装版的设置与凭据，也不会更新已安装的应用。

`pnpm run build` 只构建 Host、Client 与 Web 产物，不生成桌面应用；桌面打包使用 `make build` 或已准备依赖后的 `pnpm run build:desktop`。详细流程见[开发指南](docs/development.md)和 [Electron 桌面壳说明](apps/desktop-electron/README.md)。

## 数据与权限

桌面应用的会话、设置、凭据和记忆默认保存在 `~/.coding`，可通过 `$CODING_HOME` 指定其他目录；桌面端不使用 `$DSH_HOME` 覆盖。遗留数据迁移和浏览器数据目录见[安装指南](docs/user/guide/install.md)。这些目录包含用户数据，不是可随意清理的构建缓存。

默认配置采用 `workspace-write` 权限预设，对需要更高权限的操作请求审批。“完全访问”会减少确认并允许更多直接操作，只应对可信任务启用。Skills 只提供工作指引，不授予额外权限；浏览器与远程工作区的能力限制见[界面指南](docs/user/guide/index.md)。

本机应用控制属于需要显式启用的 macOS 扩展，不属于默认工具集；使用前还需准备原生 helper 并授予相应系统权限，具体要求见[电脑控制说明](packages/computer-use/computer-use/README.md)与[工具说明](packages/computer-use/tool-computer-use/README.md)。

Host 默认仅监听本机回环地址，会话遥测默认关闭。使用在线模型仍会向所选服务发送对话及任务所需的上下文，本地保存会话不等于离线运行。

<a id="run"></a>
<a id="run-from-source"></a>
<a id="运行"></a>

## 补充入口：Web、CLI 与终端

Web UI 可用于源码调试或浏览器访问。在仓库根目录准备 Node.js（`^22.19.0 || >=24.0.0`）与 [`package.json`](package.json) 指定的 pnpm，然后运行：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh web
```

默认地址为 `http://127.0.0.1:3080`，本机启动时会自动打开浏览器；`--no-open` 可关闭自动打开，`--port 0` 可选择空闲端口。通过 SSH 启动时仅打印宿主机地址，需要自行配置端口转发。`pnpm dsh web` 不会重新构建，修改源码后需重新构建产物。Web/CLI 中让 Agent 操作网页还需安装匹配的 Chromium，见[浏览器使用说明](docs/user/guide/index.md#让-agent-使用浏览器)；这不是桌面应用的安装前提。

CLI 运行时命令为 `dsh`，一次性任务和插件管理见 [CLI 说明](apps/cli/README.md)。Linux x64 的 `coding` 则是连接本地 Host 的交互式终端客户端，不是桌面 GUI，也不提供完整桌面界面；构建与安装见[Linux 安装指南](docs/user/guide/install.md#linux-终端客户端)。CLI 兼容 `$DSH_HOME` 数据目录覆盖，桌面端与它的目录规则不同。

## 文档与扩展

| 入口 | 内容 |
| --- | --- |
| [桌面安装](docs/user/guide/install.md#macos-桌面应用) | 构建、安装、签名限制与数据目录 |
| [界面指南](docs/user/guide/index.md) | 工作区、会话、终端、浏览器与远程连接 |
| [模型配置](docs/user/guide/providers.md) | Free、自定义渠道、图片输入与排错 |
| [桌面壳说明](apps/desktop-electron/README.md) | Electron 开发、Host 集成与原生验收 |
| [开发指南](docs/development.md)与[代码地图](docs/map.md) | 开发环境、检查与按任务定位代码 |
| [架构说明](docs/architecture.md)与[扩展实操手册](docs/cookbook/extension-cookbook.md) | 插件组合、添加工具、模型适配器和界面 |

开发或贡献前请阅读[项目协作指南](AGENTS.md)；构建、测试和质量检查命令以 [`package.json`](package.json) 为准。

## 反馈

Coding 的问题和建议请提交到[本仓库 Issues](https://github.com/lfhy/coding/issues)。DeepSeek Harness 的上游资料与社区入口见[上游仓库](https://github.com/deepseek-ai/deepseek-harness)。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
