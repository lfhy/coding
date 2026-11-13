# Electron 桌面壳

这个 macOS arm64 桌面壳由 `make dev`、`make install` 与 `pnpm run build:desktop` 使用，复用 Web Client、独立 Node Host 和 [Go 远程连接服务](../desktop/internal/desktopremote/service.go)。连接模式的操作限制见[用户指南](../../docs/user/guide/index.md#选择开始方式)，原生验收边界见[桌面壳与原生验收](../../docs/desktop-shell-comparison.md)。

## 开发运行

先按[开发指南](../../docs/development.md)安装依赖，再从仓库根目录运行：

```sh
make dev
```

该命令经 `pnpm run dev:electron` 构建 Host、Client、Web、远端 agent 资源和 Go helper，再构建并启动 Electron；初次安装 Electron 开发二进制需要下载。单独构建 Go helper 可用 `pnpm run build:electron-helper`，单独构建壳可用 `pnpm run build:electron`，两者都不生成安装包。`pnpm run test:electron:smoke` 需要本机图形会话，不属于默认无凭据测试；浏览器切换至 ego 后原生冒烟尚待更新验收，不沿用旧 guest 测试结论。两种模式的 SSH 路径由下述独立测试覆盖；真实外部模型请求未验收。

`pnpm run test:electron:remote-ssh` 的 Agent 模式已通过单独 opt-in 的 macOS 图形验收：在隔离 HOME 中经真实向导确认未知主机、连接 agent、选择目录和创建工作区，再由 Host 验证远程文件列表与读取、PTY resize、同目录 generation 重绑、旧连接拒绝、取消和退出。`pnpm run test:electron:remote-basic` 使用禁止 TCP 转发的回环 SSH fixture 验证默认基础模式、主机密钥确认、无远端 agent、Host 文件列表与读取、PTY 输入及 resize、本地隔离和退出清理；命令也构建 Code Mode 所需的本机隔离程序，但该原生脚本不调用模型或 Code Mode。两项测试只使用 fixture 一次性密码，不依赖用户 SSH agent、`~/.ssh` 或模型 API key；失败时保留并报告本次临时目录，成功且 Host 退出后删除。它们不属于默认测试，也不验证真实远端服务器、模型调用或安装版 SSH。`pnpm run package:electron` 与 `pnpm run build:desktop` 组装同一个生产包；`pnpm run test:electron:packaged` 则另行验收已有包。

开发 Host 使用 `~/.dsh-electron-dev`，默认工作目录为其中的 `workspace/`，Electron `userData` 位于 `electron-user-data/`；开发实例拒绝与安装版主目录（`~/.coding`）重叠。开发 Host 从仓库源码启动，需要 PATH 中的 Node，且不自动使用安装版设置与凭据。手动真实 API 测试须显式设置环境变量或只在隔离的 `workspace/.env` 中配置；Host 不读取仓库根目录 `.env`，不要将密钥写进仓库。

`pnpm run test:electron:chat-links` 验收已构建的开发态壳；先按 `make dev` 所需命令构建 Host、Web、Go helper 与 Electron 壳。`pnpm run test:electron:chat-links:packaged` 验收已有的 `dist/Coding.app`：在 macOS 图形会话中把签名包复制到短临时路径，以独立 HOME、浏览器状态和单实例锁启动，不安装或操作正在运行的应用。两种模式都恢复一次 Assistant 链接消息，点击后检查本机测试页面被 Agent 浏览器加载、右侧标签可见且已选中，并核对建页和导航请求；需要本机 Edge、Chrome 或 Chromium，不调用模型或读取用户会话。退出不确定时保留隔离目录供检查；这两项测试不验收既有用户配置和会话。旧 guest 的 `--browser-only` 验证结果不代表当前浏览器能力。

## Host、Remote-SSH 与窗口

桌面窗口启动时默认最大化，但不进入全屏。macOS 与 Windows 顶栏的空白区域支持拖动已还原的窗口；双击该区域在最大化和还原之间切换。顶栏按钮和输入框等交互区域不参与拖动，仍可正常点击或输入。

[Go helper](../desktop/cmd/electron-helper/main.go)持有 Host 启动与 Remote-SSH 生命周期：它通过共享的 `desktopremote.Service`、回环 bridge 和 `hostlaunch` 的 `ReplaceCompatibleHost` 发现或替换兼容 Host，并向 Electron 主进程报告经过验证的回环 origin。Host 的 HTTP 和 WebSocket 由窗口直接访问，不经 main 转发；窗口只允许该 origin 的导航，拒绝弹窗、跨源 frame 导航和网页原生权限请求。回环 origin 不是身份认证，不得把 Host token、凭据或私有路径放进 URL 或页面存储。

主进程用 `process.ppid === 1` 判定本次是否由 launchd 启动（Finder、Dock 或 LaunchServices），并把结论作为 `--gui-launch` 交给 Go helper：这种启动继承的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，模型执行的命令找不到 Homebrew、nvm、Go 等用户目录，`hostlaunch` 因此用交互式登录 shell（`$SHELL -ilc`，6 秒上限）展开的 PATH 替换继承值，`SHELL` 缺失、探测失败或超时时回退继承环境。终端启动（含 `make dev`）不传该标记，继承的 PATH 保持原值，调用方仍可用 `Options.Environment` 的 `PATH` 显式覆盖。判据只能在主进程求值：launchd 的子进程是主进程，Go helper 是主进程的子进程，在启动器里观察父进程永远得不出结论。Host 与模型侧 Bash 工具仍以 `bash -c` 运行一次性命令，补全只改变继承的 PATH 值。

远程连接的 sandbox preload 只暴露固定操作；main 每次调用都核验所属窗口、主 frame、Host origin 与输入，同源重载期间暂停授权，失去所属窗口即撤销。基础模式使用 SFTP 文件读写编辑和搜索、POSIX 远端上一条常驻 Shell 的目录列举与路径规范化、SSH 前后台命令及 PTY、本机隔离 Goja 的 Code Mode 远端工具 binding，不部署远端 agent 或使用 SSH TCP 转发；LSP 不可用。SFTP 写入需要服务端 hardlink／posix-rename 扩展，版本复核非原子 CAS；SSH PTY 不提供前台进程组查询，终止请求也不能证明整棵进程树停稳。Agent 模式需要部署 Go agent 并使用 `direct-tcpip` 转发。SSH 输入由向导按次提交给原生服务，Go bridge token 不交给 renderer；不得在页面存储或日志中持久化凭据。目录解析前失去页面且无法确认 marker 归属时，helper 会保守保留连接直至退出，不凭连接 ID 盲关已有工作区。

macOS 菜单和托盘提供窗口操作，红色关闭按钮只隐藏窗口，再次激活或从托盘可恢复；菜单退出或 `Cmd+Q` 才退出应用。显式退出时，main 立即隐藏并销毁窗口，向 helper 发送显式 `shutdown {}`；helper 收敛自己持有的远程连接、bridge 与本次启动的 Host，main 有界等待其响应，再关闭 helper 并退出进程。重复退出请求共用一次清理，退出中不重新启动 helper。窗口关闭后复开先等待旧 helper 关闭，才重新发现 Host。helper 异常断管或收到信号后也只尝试停止原本由它启动的 Host；Host 已被替换或身份无法核验时不发送停止信号，更不会扫描共享 Home 误停其他 Host。

helper 的启动取消、协议失败和 fallback 关闭都保留 12 秒清理宽限，之后才强停本次 helper，并最多再等待 1 秒回收。Host 替换由[共享启动器](../internal/hostlaunch/README.md)串行退休旧 owner：收到退出请求不等于退出完成，发现记录消失也不代表共享 Home 已释放；旧 owner 未退出时新 Host 不启动。

桌面浏览器由 Host 中的 [ego 提供方](../../packages/browser/browser-ego-host/)启动并隔离会话，模型操作由[浏览器工具](../../packages/browser/tool-browser-ego/)登记和审批。工作台的[Agent 浏览器面板](../../packages/client/ui-browser-ego/README.md)通过同源 Host 接口查看页面和实时画面，并发送基础人工操作；它不使用 Electron guest，也不通过主进程向页面暴露浏览器控制入口。桌面 preload 只暴露受限 Remote-SSH 方法，不把 Host 浏览器的进程、会话或凭据交给 renderer。浏览器需要本机可用的 Edge、Chrome 或 Chromium，不会由 Electron 自带的渲染进程替代。

Host 浏览器和页面在 Host 侧管理，不依赖 Electron 浏览器桥的令牌或独立 guest。面板显示时按会话订阅页面与实时 JPEG 画面，只能对当前会话内、仍有效的页面发送基础人工输入；隐藏时停止画面流与输入，重新打开后取得最新画面。模型浏览器工具继续遵守会话审批和本机文件边界；远程工作区不支持浏览器操作。不要将上游页面快照、调试输出或浏览器内部状态直接用作工作台文案。

## 打包与安装边界

`pnpm run build:desktop` 组装 `dist/Coding.app` macOS arm64 包，使用 `com.coding.desktop` bundle identifier。打包不会触碰 `/Applications/Coding.app`；只有调用 `make install` 才将新包安装到该路径，并替换已有应用。打包资源包含 Electron Framework、独立 Host runtime、Go helper 和 remote-agent；打包脚本核验 Host 生产闭包内的 `coding-browser-ego-host` 入口、浏览器运行时、采集 worker 与许可证／来源声明，不再要求 `coding-browser-electron`、Playwright JavaScript 包或另行捆绑 Chromium 浏览器。运行时仍需本机可用的 Edge、Chrome 或 Chromium。

本机包经 ad-hoc 深签名；`pnpm run test:electron:packaged` 在隔离 HOME 中直接运行 `.app`。该脚本的旧 guest 浏览器断言尚待迁移，更新前不能视为 ego 浏览器的验收；生产包的完整原生浏览器验证另行执行。生产配置使用已有 `~/.coding`（首次启动自动从 `~/.dsh` 迁移）与单独的 `~/.dsh-electron-user-data`；helper 在操作共享 Home 前取得安装版单实例锁，获锁失败时不得碰共享 Home。桌面 preload 的无凭据远程连接取消、单实例及退出清理可在原生冒烟更新后重验；原生菜单/托盘点击、真实外部模型请求和安装后运行仍不在该冒烟覆盖范围；Windows/Linux 原生运行尚未验证。
