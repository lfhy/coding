# 桌面壳对比：Wails v2 与 Electron

本文是 Coding 个人客户端的桌面壳替换参考，不是技术选型结论或迁移承诺。比较范围是窗口、Host 连接、原生能力和本机打包；会话、设置、凭据、LLM 与 UI 业务仍由 [Client 和 Host 插件](architecture.md)拥有。

## 归属与连接

| 事项 | 当前 Wails v2 | Electron 替换时需要确定的归属 |
| --- | --- | --- |
| 窗口与启动 | [Go 壳](../apps/desktop/main.go)持有窗口、菜单、托盘、单实例锁和静态启动页；[hostlaunch](../apps/internal/hostlaunch/launcher.go)在启动锁内发现或启动独立 Node Host，校验就绪记录、PID 和 `host.describe`，再把整窗导航到随机 `127.0.0.1` 端口。macOS 关闭窗口只隐藏到托盘，应用退出后共享 Host 仍按自身空闲策略运行。 | Electron main 持有窗口、菜单、托盘和单实例；Host 仍是独立进程。须明确是复用 Go 启动器的协议还是将其移植到 main，保留启动锁、就绪证明、失败与退出收敛，不把 Host 业务搬入 renderer。 |
| UI、HTTP 与 WS | [Wails asset server](../apps/desktop/main.go)只提供启动页；导航后，[Web/Host](../packages/client/connection/src/index.ts)直接拥有页面、`/api` HTTP 和 WebSocket，壳不转发 `/api`。Host/Origin/Fetch-Metadata 防护限制跨站和 DNS rebinding，但[不是身份认证](../packages/client/connection/src/api-request-trust.ts)。 | 可评估 Electron 自定义 scheme 服务静态页、main 转发 HTTP，并对 WS upgrade 另行建立连接/认证路径；不能假定 `fetch` 转发同时覆盖 WebSocket。若仍直连 loopback，也须限定页面来源和 Host 请求。两种路径均需验证流式响应、取消、下载与 WS 重连。 |
| 原生 IPC | [Wails binding](../apps/desktop/desktop_bindings.go)允许回环 origin 调用，但敏感方法逐次验证窗口随机 token；只有精确匹配就绪 Host origin 才[向 WebView 注入](../apps/desktop/main.go) token 和最小调用面。 | Electron preload 只暴露有类型的最小 API，main 对每次 IPC 核验主窗口、发送 frame、origin 和输入；`contextIsolation`、sandbox 与禁用 renderer Node 不代替逐调用授权。原生 IPC 不应成为通用 Host RPC。 |
| Remote-SSH | [Go manager](../apps/desktop/internal/remoteagent/manager.go)持有 SSH 连接、host-key 确认和 agent 部署；[Go 回环 bridge](../apps/desktop/remote_bridge.go)只接受 Host 携带独立 bearer token、连接与 marker identity 的请求，Node 不持有 SSH 凭据。退出时先收敛连接再关闭 bridge。 | 保留 Go Remote-SSH manager、remote-agent 和托盘能力，先定义 Electron main 与 Go helper 的受限进程协议及生命周期；不能用 renderer IPC 或 Host 的 HTTP/WS 通道绕开现有 SSH、marker 和关闭顺序。是否最终改写 Go 能力是另一个决策。 |

Electron 参考实现位于相邻仓库 `deepseek-harness` 的 `apps/desktop/src/`（核对版本 `ddefc45fbc7f`）：`main.ts` 用 `dsh-app://app` 提供静态文件并转发 HTTP，`web-document.ts` 用 Host 颁发的 cookie 代理请求，WS 在 main 限定目标、窗口和 origin 后注入 cookie；`preload-app.ts` 与 `ipc.ts` 限定预加载 API 和 IPC 发送方。它的 Host 是由 Electron Node 模式启动、通过进程 IPC 报告就绪的受管子进程（`host-process.ts`），并非 Coding 的 `host.json`/共享 home 协议；这些是参考边界，不能直接复制认证假设或安装/更新流程。

## Browser Use 与开发隔离

Electron 自带 Chromium 不等于已具备 Browser Use。相邻仓库 `deepseek-harness` 当前的右侧 Browser 是用户侧 iframe，模型 Browser Use 是另行显式装配的实验 Provider，两者并未连接。相邻仓库 `ZCode` 的 `packages/desktop/src/`（核对版本 `29628c9acdb8`）由 renderer `<webview>` guest、main 的 `browserView/browserGuestManager.ts`、`browserDataManager.ts` 的独立持久 partition 和 CDP，以及 `host/browserControlMainBridge.ts` 的 Host→main 命令桥组成；它还管理 tab 所有权、视口、截图、输入、取消与 guest 销毁前的 CDP detach。Coding 当前只有 Host Web UI 与 Wails WebView，没有这套受控 guest、模型工具协议或会话投影。Wails v3 beta 的多窗口也是独立原生窗口，并不提供同窗右侧子 WebView。Browser Use 应作为单独能力设计，明确 Service Definition、Provider、Consumer、权限和日志重建规则；不得把更换桌面壳算作功能交付。

[开发入口](../Makefile)使用独立单实例 ID 与 `~/.dsh-dev`，强制从仓库源码启动 Host；安装版使用 `~/.dsh`。[hostlaunch](../apps/internal/hostlaunch/launcher.go)独占写入 `DSH_HOME`、`DSH_CWD`、`DSH_APP_VERSION`，且当前桌面壳为私有 bridge token 更换兼容的旧 Host。Electron 开发壳须维持 home、单实例和 Host 进程隔离，不能复用安装版 Host 或把 API key、SSH 密码、binding/bridge token 放进 URL、renderer 可读持久存储、日志或打包资源；当前开发 home 不自动读取安装版设置和凭据，真实 API 测试应使用开发 home 的独立配置或本地环境／忽略的 `.env`。

## 体积与验收

[macOS 打包脚本](../scripts/package-macos-app.sh)把 `dist/Coding` 放在 `Contents/MacOS`，把 `coding-host`、预展开 `runtime/`、`remote-agent/` 和 metadata 放在 `Contents/Resources`；[构建入口](../package.json)分别构建 Go 壳、Node runtime 与 remote-agent。本机 `dist/Coding.app` 的 `du -sk` 为 543000 KiB（530.3 MiB），其中 Node 可执行文件约 115 MiB、runtime 270 MiB、跨平台 remote-agent 107 MiB、Wails 可执行文件 25 MiB；本机 ZCode 3.7.7 的 Electron App 为 543580 KiB（530.8 MiB），其 Electron Framework 约 213 MiB。两款产品负载不同，总量接近不能证明迁移零增量。仅以这些部件做账面估算，保留 Coding 的独立 Node 时以 Electron Framework 替换 Go 壳约增加 190 MiB；若验证 Electron Node 模式能替代独立 Node，约增加 75 MiB，均未计入新桥接和 Browser Use 代码。这些是目录占用，不是下载体积、内存或已验证的 Coding Electron 构建；须按同一平台、架构、包含物和计量命令复测。

候选方案可分阶段验收，前一阶段未通过时不替换现有桌面入口：

1. 建立不替换现有入口的最小 Electron 原型与独立开发 home：窗口、单实例、启动失败展示和现有 Host 生命周期可在本机重现；开发实例不触碰安装版数据或凭据，菜单/托盘只在迁移验收时补齐。
2. 接通现有 Web/Host：HTTP、WS、流式输出、取消、下载与重连通过有针对性的测试；macOS 关闭窗口可恢复而不杀共享 Host，应用退出只收敛自己拥有的连接与 bridge，Host 保留现有空闲退出策略；跨 origin/非所属 frame/未授权 IPC 与 bridge 请求在产生副作用前失败。
3. 保留 Go Remote-SSH 与 remote-agent：首连、host-key 确认、marker 重绑、远端文件/终端、取消和退出清理经本机验证；密钥与 token 不进入 renderer、日志或资源包。
4. 用同一构建内容和 `du` 口径对比启动时间、常驻内存、`.app` 目录与压缩包体积，并记录平台/架构与测量条件；本机打包的 Electron Framework、Helper、Host 与 Go helper 须完成签名校验和安装后启动验证，正式分发公证另行决策。只有功能、安全及开发隔离均达标后，再决定是否切换默认桌面入口。Browser Use 若纳入目标，另设能力与真实浏览器交互验收，不混入壳替换的完成定义。
