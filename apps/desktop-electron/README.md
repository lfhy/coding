# Electron 桌面壳

这个 macOS arm64 桌面壳由 `make dev`、`make install` 与 `pnpm run build:desktop` 使用，复用 Web Client、独立 Node Host 和 [Go 远程连接服务](../desktop/internal/desktopremote/service.go)。连接模式的操作限制见[用户指南](../../docs/user/guide/index.md#选择开始方式)，原生验收边界见[桌面壳与原生验收](../../docs/desktop-shell-comparison.md)。

## 开发运行

先按[开发指南](../../docs/development.md)安装依赖，再从仓库根目录运行：

```sh
make dev
```

该命令经 `pnpm run dev:electron` 构建 Host、Client、Web、远端 agent 资源和 Go helper，再构建并启动 Electron；初次安装 Electron 开发二进制需要下载。单独构建 Go helper 可用 `pnpm run build:electron-helper`，单独构建壳可用 `pnpm run build:electron`，两者都不生成安装包。`pnpm run test:electron:smoke` 需要本机图形会话，不属于默认无凭据测试。开发态原生冒烟覆盖真实 Host HTTP、两条 WebSocket、无凭据的远程连接 `cancelConnect`、UI 向导及菜单/关闭复开窗口，以及回环脚本模型驱动的浏览器工具与真人共用 guest；托盘 UI 点击因 macOS 锁屏未验收。两种模式的 SSH 路径由下述独立测试覆盖；真实外部模型请求未验收。

`pnpm run test:electron:remote-ssh` 的 Agent 模式已通过单独 opt-in 的 macOS 图形验收：在隔离 HOME 中经真实向导确认未知主机、连接 agent、选择目录和创建工作区，再由 Host 验证远程文件列表与读取、PTY resize、同目录 generation 重绑、旧连接拒绝、取消和退出。`pnpm run test:electron:remote-basic` 使用禁止 TCP 转发的回环 SSH fixture 验证默认基础模式、主机密钥确认、无远端 agent、Host 文件列表与读取、PTY 输入及 resize、本地隔离和退出清理；命令也构建 Code Mode 所需的本机隔离程序，但该原生脚本不调用模型或 Code Mode。两项测试只使用 fixture 一次性密码，不依赖用户 SSH agent、`~/.ssh` 或模型 API key；失败时保留并报告本次临时目录，成功且 Host 退出后删除。它们不属于默认测试，也不验证真实远端服务器、模型调用或安装版 SSH。`pnpm run package:electron` 与 `pnpm run build:desktop` 组装同一个生产包；`pnpm run test:electron:packaged` 则另行验收已有包。

开发 Host 使用 `~/.dsh-electron-dev`，默认工作目录为其中的 `workspace/`，Electron `userData` 位于 `electron-user-data/`；开发实例拒绝与安装版 `~/.dsh` 重叠。开发 Host 从仓库源码启动，需要 PATH 中的 Node，且不自动使用安装版设置与凭据。手动真实 API 测试须显式设置环境变量或只在隔离的 `workspace/.env` 中配置；Host 不读取仓库根目录 `.env`，不要将密钥写进仓库。

## Host、Remote-SSH 与窗口

桌面窗口启动时默认最大化，但不进入全屏。macOS 与 Windows 顶栏的空白区域支持拖动已还原的窗口；双击该区域在最大化和还原之间切换。顶栏按钮和输入框等交互区域不参与拖动，仍可正常点击或输入。

[Go helper](../desktop/cmd/electron-helper/main.go)持有 Host 启动与 Remote-SSH 生命周期：它通过共享的 `desktopremote.Service`、回环 bridge 和 `hostlaunch` 的 `ReplaceCompatibleHost` 发现或替换兼容 Host，并向 Electron 主进程报告经过验证的回环 origin。Host 的 HTTP 和 WebSocket 由窗口直接访问，不经 main 转发；窗口只允许该 origin 的导航，拒绝弹窗、跨源 frame 导航和网页原生权限请求。回环 origin 不是身份认证，不得把 Host token、凭据或私有路径放进 URL 或页面存储。

远程连接的 sandbox preload 只暴露固定操作；main 每次调用都核验所属窗口、主 frame、Host origin 与输入，同源重载期间暂停授权，失去所属窗口即撤销。基础模式使用 SFTP 文件读写编辑和搜索、SSH 前后台命令及 PTY、本机隔离 Goja 的 Code Mode 远端工具 binding，不部署远端 agent 或使用 SSH TCP 转发；LSP 不可用。SFTP 写入需要服务端 hardlink／posix-rename 扩展，版本复核非原子 CAS；SSH PTY 不提供前台进程组查询，终止请求也不能证明整棵进程树停稳。Agent 模式需要部署 Go agent 并使用 `direct-tcpip` 转发。SSH 输入由向导按次提交给原生服务，Go bridge token 不交给 renderer；不得在页面存储或日志中持久化凭据。目录解析前失去页面且无法确认 marker 归属时，helper 会保守保留连接直至退出，不凭连接 ID 盲关已有工作区。macOS 菜单和托盘提供窗口操作，关闭窗口会隐藏，再次激活或从托盘可恢复；退出应用时 helper 先收敛自己持有的连接和 bridge，Host 仍依自身空闲策略退出。

七项[浏览器工具](../../packages/browser/tool-browser/README.md)在桌面 Host 中使用 [Electron 提供方](../../packages/browser/browser-electron/README.md)，Web/CLI 才使用 [Playwright 提供方](../../packages/browser/browser-playwright/README.md)。Electron 主进程按 Session 持有独立的临时 partition 和 `WebContentsView` 页面；工作台中的真人与 Host Agent 操作同一 guest，不是 renderer `<webview>`，也不是 PNG 镜像。人工打开链接或输入网址在目标主 frame 提交导航、核验目标 URL 后返回页面状态，不等待 DOM ready、缓慢子资源、截图或严格 DOM 观测；页面继续加载时，原生状态使地址栏持续显示加载状态，直到 guest 停止加载。模型导航仍等待完整加载并执行严格观测，模型操作仍遵守审批规则。预加载脚本只向受限 Host 主 frame 暴露定位和显隐 guest 的呈现方法，不向页面开放浏览器控制权或私有 bridge 令牌；主进程核验窗口、origin、frame 和位置，隐藏工作台或切换标签仅卸载视图，关闭标签、Session 或销毁窗口才释放相应资源。主进程截图通过共享尺寸／字节预算策略和原生 PNG 编码器满足桥接限额，不改变实时 guest 画面；模型显式截图另经附件服务归一化并持久保存，桌面 Client 无需轮询 PNG 显示。

Host 经启动环境中的一次性令牌连接主进程私有回环 WebSocket；令牌不进入 URL 或 renderer。断线、超时或取消会使该 Host 的浏览器会话失效，当前 Host 进程不会自动重连，也不能静默改用 Playwright。Agent 操作从审批等待至结束独占 Session，期间人工命令被拒绝，原生 guest 暂时隐藏以免发生未授权输入。工作台在租约期间送来的呈现尺寸会先应用于未挂载的 guest，后续观测使用该视口；释放租约时挂回视图不会仅因附着而使新观测过期，真人之后调尺寸仍会使旧引用过期。同文档的无关兄弟分支内容更新不会仅因全局变化撤销模型元素引用；目标、表单和祖先路径变化仍可能使旧引用过期，详见 [Electron 提供方](../../packages/browser/browser-electron/README.md)。完全访问且关闭审批提示的会话无需逐次审批，其他组合仍遵循工具的会话权限规则；远程工作区不支持浏览器操作。guest 禁用下载、弹窗、页面权限请求以及访问 Host origin，不提供任意页面脚本入口。

## 打包与安装边界

`pnpm run build:desktop` 组装 `dist/Coding.app` macOS arm64 包，使用 `com.coding.desktop` bundle identifier。打包不会触碰 `/Applications/Coding.app`；只有调用 `make install` 才将新包安装到该路径，并替换已有应用。打包资源包含 Electron Framework、独立 Host runtime、Go helper 和 remote-agent；桌面浏览器使用 Electron 自带的原生 guest，包不交付或下载单独的 Playwright Chromium headless shell，也不需要 `PLAYWRIGHT_BROWSERS_PATH` 指向包内浏览器。

本机包经 ad-hoc 深签名；`pnpm run test:electron:packaged` 在隔离 HOME 中直接运行 `.app`，验证 `app.isPackaged`、`app.asar`、真实 Host 页面与两条 WebSocket，以及回环脚本模型通过 Host 执行 `browser_navigate`、`browser_snapshot`、`browser_click` 并与真人共用原生 guest。该冒烟还覆盖 preload 到 Go helper/bridge 的无凭据取消、单实例及退出清理，不安装或公证。生产配置使用已有 `~/.dsh` 与单独的 `~/.dsh-electron-user-data`；helper 在操作共享 Home 前取得安装版单实例锁，获锁失败时不得碰共享 Home。原生菜单/托盘点击、关窗隐藏、远程连接、真实外部模型请求和安装后运行不在该冒烟覆盖范围；Windows/Linux 原生运行尚未验证。
