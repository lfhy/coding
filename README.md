# Coding

Coding 是面向个人开发的开源 AI 编程客户端。它在本机运行 Host，将模型对话、代码操作和开发工具放在同一个工作台中，并提供 macOS 桌面应用、浏览器界面与 Linux 终端客户端。

项目基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，由 [Cordis](https://github.com/cordiverse/cordis) 组织插件。模型适配器、工具、会话管理与客户端功能都通过插件组合，可以按需要扩展或替换。

> 项目处于开发者预览阶段，功能、配置与数据格式可能发生不兼容变更。使用以源码构建为主，尚未提供可下载的桌面安装包。

## 能做什么

- **完成编程任务**：读取、搜索和编辑项目文件，执行命令与测试，查看工具调用及结果。
- **使用集成工作台**：在桌面与 Web 界面中浏览文件、预览内容、使用终端、查看 Git 变更与提交历史。
- **选择模型渠道**：默认提供无需自行配置密钥的 Free 渠道，也可接入自己的模型服务与兼容端点。
- **处理持续任务**：维护计划和目标，运行后台任务，委派子代理并继续已有会话。
- **连接网页与远程项目**：让 Agent 操作会话浏览器；桌面端可通过 SSH 连接远程工作区，两者的可用范围和权限要求见[界面指南](docs/user/guide/index.md)。
- **生成交互内容**：在回答中呈现 GenUI 表格、图表、表单和流程图，语法与限制见 [GenUI 说明](packages/genui/genui/README.md)。

<a id="run"></a>

## 运行

<a id="run-from-source"></a>

### 从源码启动 Web UI

准备 Git、Node.js（`^22.19.0 || >=24.0.0`）和仓库指定的 pnpm；pnpm 版本以 [`package.json`](package.json) 的 `packageManager` 为准，环境搭建见[开发指南](docs/development.md#前置条件)。随后运行：

```sh
git clone https://github.com/lfhy/coding.git
cd coding
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh web
```

启动成功后，终端会打印访问地址，默认是 `http://127.0.0.1:3080`，本机启动时会自动打开默认浏览器。传入 `--no-open` 可关闭自动打开，`--port 0` 可让系统选择空闲端口。通过 SSH 启动时仅打印宿主机地址，需要自行配置端口转发。

在 Web/CLI 中让 Agent 操作网页，还需准备与锁定 Playwright 版本匹配的 Chromium，安装方式见[界面指南](docs/user/guide/index.md#让-agent-使用浏览器)；桌面应用使用 Electron 自带的浏览器，无需单独安装。

`pnpm run build` 构建 Host、Client 与 Web 产物，不生成桌面应用。`pnpm dsh web` 只启动应用，不会重新构建；修改源码后需重新运行构建。命令使用运行时名称 `dsh`，Linux 交互式终端客户端的命令则是 `coding`。其他运行模式、一次性任务和插件管理见 [CLI 说明](apps/cli/README.md)。

### macOS 桌面应用

macOS arm64 可从仓库根目录构建并打开 Electron 应用。若系统缺少 `make`，先运行 `xcode-select --install` 安装 Xcode 命令行工具：

```sh
make build
open dist/Coding.app
```

`make build` 会检查并补齐构建工具、安装锁定依赖，然后生成 `dist/Coding.app`，不会替换系统应用目录中的已有应用。应用包含独立 Node Host，运行时无需单独安装 Node；本机包仅做 ad-hoc 签名，未经 Apple 公证，复制到其他机器后可能被 Gatekeeper 阻止。

安装到系统应用目录的步骤与覆盖行为见[安装指南](docs/user/guide/install.md#macos-桌面应用)。开发调试可使用 `make dev`，具体环境和验收限制见 [Electron 桌面壳说明](apps/desktop-electron/README.md)。

### Linux 终端客户端

Linux x64 使用交互式 `coding` 终端客户端，连接本地 Host，支持会话交互与审批。它不是桌面 GUI，也不提供 Web 工作台的全部界面能力。构建客户端、安装 Host 与配置 `PATH` 请按[Linux 安装指南](docs/user/guide/install.md#linux-终端客户端)操作。

Linux 与 Windows 的 Electron 原生运行尚未验收，Windows 暂无桌面安装包。

## 首次使用

1. **选择工作区**：打开项目文件夹，或选择“不在项目中工作”创建会话。
2. **确认模型**：默认使用 Free 渠道的 Auto 模型，无需自行配置密钥。需要自己的服务时，在“设置 → 模型”中添加渠道、凭据和可用模型；详见[模型配置指南](docs/user/guide/providers.md)。
3. **描述任务**：例如“阅读这个项目，修复登录失败的问题，并运行相关测试”。需要审批时，界面会请求确认；完成后检查文件变更和验证结果。

Free 依赖第三方免费服务，可能受到地区限制、限流或上游故障影响，不保证始终可用。Auto 会在候选模型尚未开始回复时尝试故障转移；可选模型、切换规则与排错见[Free 渠道说明](docs/user/guide/providers.md#内置渠道free)。

## 数据与权限

会话、设置、凭据和记忆默认保存在 `~/.coding`，可通过 `$CODING_HOME` 指定其他目录。CLI 还兼容 `$DSH_HOME`，Electron 桌面端不使用该变量。遗留数据迁移与各客户端目录规则见[安装指南](docs/user/guide/install.md)；这些目录包含用户数据，不是可随意清理的构建缓存。

Electron 开发实例使用独立的 `~/.dsh-electron-dev`，不读取安装版的设置与凭据。调试源码不会自动更新已安装的应用。

默认配置采用 `workspace-write` 权限预设，对需要更高权限的操作请求审批。可在界面调整权限；“完全访问”会减少确认并允许更多直接操作，只应对可信任务启用。浏览器与远程工作区另有能力和权限限制，见[界面指南](docs/user/guide/index.md)。

Host 默认仅监听本机回环地址，会话遥测默认关闭。使用在线模型仍会向所选服务发送对话及任务所需的上下文，本地保存会话不等于离线运行。

## 文档与开发

| 入口 | 内容 |
| --- | --- |
| [安装与运行](docs/user/guide/install.md) | 桌面应用、Linux 终端客户端、Host 与数据目录 |
| [界面指南](docs/user/guide/index.md) | 工作区、会话、终端、浏览器与远程连接 |
| [模型配置](docs/user/guide/providers.md) | Free、自定义渠道、图片输入与排错 |
| [开发指南](docs/development.md) | 工具准备、源码开发、构建与本地检查 |
| [代码地图](docs/map.md) | 按任务定位代码、包归属与连带改动 |
| [架构说明](docs/architecture.md) | Cordis、插件组合、会话日志与能力扩展 |
| [扩展实操手册](docs/cookbook/extension-cookbook.md) | 添加工具、模型适配器、界面和设置 |
| [Python SDK](docs/user/guide/python-sdk.md) | 通过 Python 驱动 Agent |

开发或贡献前请阅读[项目协作指南](AGENTS.md)；构建、测试和质量检查命令以 [`package.json`](package.json) 为准。

## 反馈

Coding 的问题和建议请提交到[本仓库 Issues](https://github.com/lfhy/coding/issues)。DeepSeek Harness 的上游资料与社区入口见[上游仓库](https://github.com/deepseek-ai/deepseek-harness)。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
