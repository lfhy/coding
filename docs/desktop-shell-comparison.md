# 桌面壳对比：Wails v2 与 Electron

本文是 Coding 个人客户端的桌面壳对比与迁移验收参考，不是切换默认入口的承诺。比较范围是窗口、Host 连接、原生能力和本机打包；会话、设置、凭据、LLM 与 UI 业务仍由 [Client 和 Host 插件](architecture.md)拥有。并存壳的运行方式与限制由 [Electron 应用 README](../apps/desktop-electron/README.md)记录。

## 归属与连接

| 事项 | 默认 Wails v2 | Electron 并存壳及验收边界 |
| --- | --- | --- |
| 窗口与启动 | [Go 壳](../apps/desktop/main.go)持有窗口、菜单、托盘、单实例锁和静态启动页；[hostlaunch](../apps/internal/hostlaunch/launcher.go)在启动锁内发现或启动独立 Node Host，校验就绪记录、PID 和 `host.describe`，再把整窗导航到随机 `127.0.0.1` 端口。macOS 关闭窗口只隐藏到托盘，应用退出后共享 Host 仍按自身空闲策略运行。 | [Electron main](../apps/desktop-electron/src/main.ts)管理单实例、macOS 菜单、托盘与关窗隐藏；Go helper 通过共享 hostlaunch 启动或替换兼容 Host。开发态菜单及关闭复开窗口已有原生冒烟覆盖，托盘 UI 点击因锁屏未验收；隔离 HOME 的打包版通过单实例与退出清理，未覆盖原生菜单/托盘点击及关窗隐藏。 |
| UI、HTTP 与 WS | [Wails asset server](../apps/desktop/main.go)只提供启动页；导航后，[Web/Host](../packages/client/connection/src/index.ts)直接拥有页面、`/api` HTTP 和 WebSocket，壳不转发 `/api`。Host/Origin/Fetch-Metadata 防护限制跨站和 DNS rebinding，但[不是身份认证](../packages/client/connection/src/api-request-trust.ts)。 | 窗口直连 helper 核验的回环 Host origin，不在 main 中转发 `/api` 或 WebSocket；限制导航、弹窗和网页权限。开发态及隔离 HOME 的打包版均实测 Host 页面与双 WebSocket；流式输出、下载和重连仍需实机验证。回环地址不是身份认证。 |
| 原生 IPC | [Wails binding](../apps/desktop/desktop_bindings.go)允许回环 origin 调用，但敏感方法逐次验证窗口随机 token；只有精确匹配就绪 Host origin 才[向 WebView 注入](../apps/desktop/main.go) token 和最小调用面。 | [sandbox preload](../apps/desktop-electron/src/preload.ts)只暴露固定 Remote-SSH 方法；[main](../apps/desktop-electron/src/remote-ipc.ts)逐调用校验窗口、主 frame、origin 与输入，重载和销毁会撤权。没有 Browser guest；回环 SSH fixture 已贯通真实向导和 Host 路径。 |
| Remote-SSH | [Go manager](../apps/desktop/internal/remoteagent/manager.go)持有 SSH 连接、host-key 确认和 agent 部署；[共享 Go 回环 bridge](../apps/desktop/internal/desktopremote/bridge.go)只接受 Host 携带独立 bearer token、连接与 marker identity 的请求，Node 不持有 SSH 凭据。退出时先收敛连接再关闭 bridge。 | [Go helper](../apps/desktop/cmd/electron-helper/main.go)使用相同 `desktopremote.Service` 与 bridge，stdio 协议受限于固定操作。开发态回环 SSH fixture 验证首连、host-key、agent、目录 marker/workspace、Host 文件列表/读取、PTY resize、generation 重绑、旧连接拒绝、取消及退出；真实远端服务器和安装版 SSH 未验收。 |

Electron 参考实现位于相邻仓库 `deepseek-harness` 的 `apps/desktop/src/`（核对版本 `ddefc45fbc7f`）：`main.ts` 用 `dsh-app://app` 提供静态文件并转发 HTTP，`web-document.ts` 用 Host 颁发的 cookie 代理请求，WS 在 main 限定目标、窗口和 origin 后注入 cookie；`preload-app.ts` 与 `ipc.ts` 限定预加载 API 和 IPC 发送方。它的 Host 是由 Electron Node 模式启动、通过进程 IPC 报告就绪的受管子进程（`host-process.ts`），并非 Coding 的 `host.json`/共享 home 协议；这些是参考边界，不能直接复制认证假设或安装/更新流程。

## Browser Use 与开发隔离

Electron 自带 Chromium 不等于已具备 Browser Use。相邻仓库 `deepseek-harness` 当前的右侧 Browser 是用户侧 iframe，模型 Browser Use 是另行显式装配的实验 Provider，两者并未连接。相邻仓库 `ZCode` 的 `packages/desktop/src/`（核对版本 `29628c9acdb8`）由 renderer `<webview>` guest、main 的 `browserView/browserGuestManager.ts`、`browserDataManager.ts` 的独立持久 partition 和 CDP，以及 `host/browserControlMainBridge.ts` 的 Host→main 命令桥组成；它还管理 tab 所有权、视口、截图、输入、取消与 guest 销毁前的 CDP detach。Coding 当前只有 Host Web UI 与 Wails WebView，没有这套受控 guest、模型工具协议或会话投影。Wails v3 beta 的多窗口也是独立原生窗口，并不提供同窗右侧子 WebView。Browser Use 应作为单独能力设计，明确 Service Definition、Provider、Consumer、权限和日志重建规则；不得把更换桌面壳算作功能交付。

[Wails 开发入口](../Makefile)使用独立单实例 ID 与 `~/.dsh-dev`，强制从仓库源码启动 Host；安装版使用 `~/.dsh`。[hostlaunch](../apps/internal/hostlaunch/launcher.go)独占写入 `DSH_HOME`、`DSH_CWD`、`DSH_APP_VERSION`，为私有 bridge token 更换兼容的旧 Host。Electron 开发态使用独立 `~/.dsh-electron-dev`，不自动读取安装版设置和凭据；Host 在隔离工作目录读取 `.env`，不会读取仓库根目录的 `.env`。Electron 生产配置使用已有 `~/.dsh`，但 `userData` 独立置于 `~/.dsh-electron-user-data`；Go helper 先取得 Wails 正式版单实例锁，获锁失败不得碰共享 Home。任何模式均不得把 API key、SSH 密码或 bridge token 放进 URL、renderer 可读持久存储、日志或打包资源。

## 体积与验收

[Wails macOS 打包脚本](../scripts/package-macos-app.sh)组装 `dist/Coding.app`；[Electron 打包脚本](../scripts/package-electron-macos-app.ts)独立组装 `dist/CodingElectron.app`，包括 Electron Framework、Host runtime、Go helper 和 remote-agent。本机 arm64 Electron 包通过 ad-hoc 深签名和隔离 HOME 冒烟：直接运行 `.app` 验证 `app.isPackaged`、`app.asar`、真实 Host 页面及双 WebSocket、preload→Go helper/bridge 的无凭据取消、单实例和清理；尚未安装或公证。两个包的体积、启动时间和内存应以相同平台、架构、包含物与计量命令复测，不用其他产品的目录占用推定迁移成本。

候选方案可分阶段验收，前一阶段未通过时不替换现有桌面入口：

1. 开发隔离与连接：窗口连接经 helper 核验的 Host，导航、弹窗与权限被限制；开发 home 不触碰安装版设置或凭据。开发态原生冒烟覆盖 Host HTTP、双 WS、无凭据取消、向导及菜单/窗口恢复。
2. 用户行为：补足流式输出、下载、重连、关闭与复开窗口后的 Host 生命周期、启动失败展示，以及打包版原生菜单/托盘点击与关窗隐藏实测。跨 origin、非所属 frame 和未授权 IPC/bridge 请求应在产生副作用前失败。
3. Remote-SSH：本机回环 SSH fixture 经 Electron 向导、agent、Host 文件和终端、generation 重绑、取消及退出验收；真实远端服务器与安装版 SSH 需另行验证。密钥与 token 不进入 renderer、日志或资源包。
4. 包体验证：按同一平台和口径对比启动时间、内存、`.app` 与压缩包体积；隔离 HOME 下的已签名 `.app` 可启动，但安装后的隔离与原生交互仍需验证，正式分发公证另行决策。只有功能、安全及开发隔离均达标后，再决定是否切换默认入口。Browser Use 若纳入目标，另设能力与真实浏览器交互验收，不混入壳替换的完成定义。
