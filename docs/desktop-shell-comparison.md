# Electron 桌面壳与原生验收

本文记录 Coding macOS arm64 桌面壳的 Host 连接、原生授权和验收边界。会话、设置、凭据、LLM 与 UI 业务仍由 [Client 和 Host 插件](architecture.md)拥有；运行命令与配置限制见 [Electron 应用 README](../apps/desktop-electron/README.md)。

## 归属与连接

| 事项 | 所属实现与边界 |
| --- | --- |
| 窗口与启动 | [Electron main](../apps/desktop-electron/src/main.ts)管理单实例、macOS 菜单、托盘与关窗隐藏；[Go helper](../apps/desktop/cmd/electron-helper/main.go)经共享 [hostlaunch](../apps/internal/hostlaunch/launcher.go) 启动或替换兼容 Host，核验就绪记录、PID 和 `host.describe` 后将窗口导航到随机回环端口。应用退出后共享 Host 仍按自身空闲策略运行。 |
| UI、HTTP 与 WS | 窗口直连核验的 Host origin，[Web/Host](../packages/client/connection/src/index.ts)拥有页面、`/api` HTTP 和双 WebSocket；main 不转发请求。窗口限制导航、弹窗和网页权限。Host/Origin/Fetch-Metadata 防护限制跨站和 DNS rebinding，但[不是身份认证](../packages/client/connection/src/api-request-trust.ts)。 |
| 原生 IPC | [sandbox preload](../apps/desktop-electron/src/preload.ts)只暴露固定远程连接方法；[main](../apps/desktop-electron/src/remote-ipc.ts)逐调用校验窗口、主 frame、origin 与输入，同源重载期间暂停授权，窗口销毁后撤权。 |
| 远程连接 | [Go manager](../apps/desktop/internal/remoteagent/manager.go)持有 SSH 连接与 host-key 确认；基础模式用 SSH/SFTP，无远端 agent 或 TCP 转发，Agent 模式部署 Go agent。[回环 bridge](../apps/desktop/internal/desktopremote/bridge.go)要求 Host 携带独立 bearer token、连接与 marker identity，Node 不持有 SSH 凭据；退出时先收敛连接再关闭 bridge。模式能力见[用户指南](user/guide/index.md#选择开始方式)。 |

Electron 自带 Chromium 不等于 Browser Use。当前没有受控 browser guest、模型工具协议或会话投影；增加这项能力需另行定义 Provider、权限和日志重建规则。

## 开发隔离与打包

[hostlaunch](../apps/internal/hostlaunch/launcher.go)独占写入 `DSH_HOME`、`DSH_CWD`、`DSH_APP_VERSION`。开发态使用独立 `~/.dsh-electron-dev`，不自动读取安装版设置和凭据；Host 在隔离工作目录读取 `.env`，不会读取仓库根目录的 `.env`。生产配置使用已有 `~/.dsh`，Chromium `userData` 使用 `~/.dsh-electron-user-data`；Go helper 先取得安装版单实例锁，获锁失败不得碰共享 Home。API key、SSH 密码和 bridge token 不得进入 URL、renderer 可读持久存储、日志或打包资源。

[打包脚本](../scripts/package-electron-macos-app.ts)组装 `dist/Coding.app`，包含 Electron Framework、Host runtime、Go helper 和 remote-agent，使用 `com.coding.desktop` bundle identifier。`pnpm run build:desktop` 不触碰 `/Applications/Coding.app`；`make install` 才会替换该路径上的已有应用。macOS 包经本机 ad-hoc 深签名；正式分发公证另行决定。

## 验收边界

- 开发态 macOS 原生冒烟已覆盖 Host 页面与双 WebSocket、无凭据取消、向导、菜单及关闭复开窗口；托盘 UI 点击因测试时锁屏未验收。
- 隔离 HOME 的 macOS arm64 打包版直接运行 `.app`，已验证 `app.isPackaged`、`app.asar`、真实 Host 页面和双 WebSocket、preload→Go helper/bridge 的无凭据取消、单实例及退出清理；未安装或公证。流式输出、下载、重连、启动失败展示及打包版原生菜单/托盘点击、关窗隐藏仍需实测。
- 开发态回环 SSH fixture 覆盖 Agent 模式的向导、host-key、目录 marker/workspace、Host 文件列表/读取、PTY resize、generation 重绑、旧连接拒绝、取消及退出；基础模式另验证默认选择、禁转发、无远端 agent、Host 文件列表/读取、PTY 输入及 resize 和退出清理。Code Mode 的远端 Bash 由 Go 回环 SSH 集成测试覆盖；真实远端服务器、模型调用和安装版 SSH 未验收。
- Windows/Linux 原生 Electron 运行、安装后运行及 Browser Use 未验收。跨 origin、非所属 frame 和未授权 IPC/bridge 请求必须在产生副作用前失败。
