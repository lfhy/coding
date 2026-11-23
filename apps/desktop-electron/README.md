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

`pnpm run test:electron:chat-links` 验收已构建的开发态壳；先按 `make dev` 所需命令构建 Host、Web、Go helper 与 Electron 壳。`pnpm run test:electron:chat-links:packaged` 验收已有的 `dist/Coding.app`：在 macOS 图形会话中把签名包复制到短临时路径，以独立 HOME、浏览器状态和单实例锁启动，不安装或操作正在运行的应用。

两种模式都点击预置会话中的 Assistant 链接，验证原生视图绘制网页、空闲时不取帧、截图期间不重排，以及切换会话时只显示各自的右栏。本地模型替身触发真实的截图工具；测试不读用户会话、设置或凭据。退出不确定时保留隔离目录供检查。

## Host、Remote-SSH 与窗口

桌面窗口启动时默认最大化，但不进入全屏；macOS 侧边（含自动隐藏）的 Dock 会让系统可用区域窄一条，此时窗口改用整屏宽度，只保留菜单栏高度与工作区底边，启动和手动最大化后右侧都不露桌面。macOS 与 Windows 顶栏的空白区域支持拖动已还原的窗口；双击该区域在最大化和还原之间切换——macOS 的系统缩放只放到可用区域，主进程在缩放后补足整屏宽度并记住进入前的窗口，第二次双击因此仍能回到原尺寸，手动拖动改过窗口大小后重新从最大化开始计。顶栏按钮和输入框等交互区域不参与拖动，仍可正常点击或输入。macOS 交通灯右侧的侧栏按钮收放当前页面左栏，对话、文件管理与画图共用折叠状态；同一窗口的页内收放按钮不再显示，普通 Web 沿用原位。

[Go helper](../desktop/cmd/electron-helper/main.go)持有 Host 启动与 Remote-SSH 生命周期：它通过共享的 `desktopremote.Service`、回环 bridge 和 `hostlaunch` 的 `ReplaceCompatibleHost` 发现或替换兼容 Host，并向 Electron 主进程报告经过验证的回环 origin。Host 的 HTTP 和 WebSocket 由窗口直接访问，不经 main 转发；窗口只允许该 origin 的导航，拒绝弹窗、跨源 frame 导航和网页原生权限请求。回环 origin 不是身份认证，不得把 Host token、凭据或私有路径放进 URL 或页面存储。

主进程用 `process.ppid === 1` 判定本次是否由 launchd 启动（Finder、Dock 或 LaunchServices），并把结论作为 `--gui-launch` 交给 Go helper：这种启动继承的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，模型执行的命令找不到 Homebrew、nvm、Go 等用户目录，`hostlaunch` 因此用交互式登录 shell（`$SHELL -ilc`，6 秒上限）展开的 PATH 替换继承值，`SHELL` 缺失、探测失败或超时时回退继承环境。终端启动（含 `make dev`）不传该标记，继承的 PATH 保持原值，调用方仍可用 `Options.Environment` 的 `PATH` 显式覆盖。判据只能在主进程求值：launchd 的子进程是主进程，Go helper 是主进程的子进程，在启动器里观察父进程永远得不出结论。Host 与模型侧 Bash 工具仍以 `bash -c` 运行一次性命令，补全只改变继承的 PATH 值。

远程连接的 sandbox preload 只暴露固定操作；main 每次调用都核验所属窗口、主 frame、Host origin 与输入，同源重载期间暂停授权，失去所属窗口即撤销。基础模式使用 SFTP 文件写入、编辑与搜索，POSIX 远端上一条常驻 Shell 承担目录列举、路径规范化、单路径元数据与文本文件读取（一次脚本完成类型检查、读取前后元数据比对与传输），二进制读取仍走 SFTP、SSH 前后台命令及 PTY、本机隔离 Goja 的 Code Mode 远端工具 binding，不部署远端 agent 或使用 SSH TCP 转发；LSP 不可用。SFTP 写入需要服务端 hardlink／posix-rename 扩展，版本复核非原子 CAS；SSH PTY 不提供前台进程组查询，终止请求也不能证明整棵进程树停稳。Agent 模式需要部署 Go agent 并使用 `direct-tcpip` 转发。SSH 输入由向导按次提交给原生服务，Go bridge token 不交给 renderer；不得在页面存储或日志中持久化凭据。目录解析前失去页面且无法确认 marker 归属时，helper 会保守保留连接直至退出，不凭连接 ID 盲关已有工作区。

打开已有远程工作区（含在其中新建对话）时，`desktopremote.Service.RemoteSSHReconnectWorkspace` 先核对该工作区已发布的本地 marker 文件、bridge 当前路由与连接管理器中的活连接。核对通过时沿用原 SSH 连接与 marker 世代，不要求保存凭据，不重新握手、不查询远端目录、不发布 marker，也不等待旧对话的在途远端请求结束。工具请求仍由 bridge 单独授权，显式重绑仍发布新世代。

没有可复用路由时，只能通过与该工作区匹配的已保存档案自动恢复：优先尝试用档案对应的可用连接恢复路由，必要时重新建立 SSH 连接。连接已断开且没有可用档案时须通过向导手动重连，不回退到本机。

工具请求的 marker 路由只在 bridge 内存里：helper 重启后路由为空，而磁盘 marker 仍是上一次发布的身份，此时请求按该身份指向的活连接按需采纳回路由；连接本身已经不在（重启后未重连或会话中途掉线）时，bridge 只有在存在匹配的已保存档案时才会自动恢复一次，重新发布 marker 后继续本次请求，同一 marker 根同时只跑一轮且成功后 5 秒内不重复触发。已有路由时旧文件一律不采纳，世代不符仍按过期拒绝；自动重连失败保持快速失败，不会静默降级到本机。

macOS 菜单和托盘提供窗口操作，红色关闭按钮只隐藏窗口，再次激活或从托盘可恢复；菜单退出或 `Cmd+Q` 才退出应用。显式退出时，main 立即隐藏并销毁窗口，向 helper 发送显式 `shutdown {}`；helper 收敛自己持有的远程连接、bridge 与本次启动的 Host，main 有界等待其响应，再关闭 helper 并退出进程。重复退出请求共用一次清理，退出中不重新启动 helper。窗口关闭后复开先等待旧 helper 关闭，才重新发现 Host。helper 异常断管或收到信号后也只尝试停止原本由它启动的 Host；Host 已被替换或身份无法核验时不发送停止信号，更不会扫描共享 Home 误停其他 Host。

helper 的启动取消、协议失败和 fallback 关闭都保留 12 秒清理宽限，之后才强停本次 helper，并最多再等待 1 秒回收。Host 替换由[共享启动器](../internal/hostlaunch/README.md)串行退休旧 owner：收到退出请求不等于退出完成，发现记录消失也不代表共享 Home 已释放；旧 owner 未退出时新 Host 不启动。

桌面上的 Agent 页面由主进程的页面宿主承载，每个页面对应一个 `WebContentsView`。主进程先建立虚拟 CDP 端点（`ego-cdp-broker.ts`），再将地址作为 `EGO_LINUX_CDP_URL` 传入本次 Go helper 的显式启动环境，Host 从 helper 继承该环境。[ego 运行时](../../packages/browser/browser-ego-host/README.md) 因此不再启动本机浏览器，而是把 `Target.*` 之外的命令转发到页面自己的调试会话；`Target.createTarget`、`Target.createBrowserContext` 与它们的释放由页面宿主实现，目标 id 由端点铸造，所以只有页面宿主登记的页面可见。模型工具仍是[浏览器工具](../../packages/browser/tool-browser-ego/)登记的 `browser_*` 全套，审批与结果不变，页面里的虚拟光标、动作标签与快照都来自运行时原本的实现。

[Agent 浏览器面板](../../packages/client/ui-browser-ego/README.md)在桌面端不再显示帧流：面板经 preload 上报矩形，主进程把同一个视图移进窗口。`egoBrowser.present` 只接受回环 Host 主 frame 和窗口内整数矩形。隐藏或切换标签时，撤回请求只影响对应的页面；后台标签不能撤下正在显示的网页。撤回不会关闭页面，页面内容、输入与命令仍走原来的通道。

`browser_screenshot` 先按页面当前的设备像素采集视口，再裁剪或缩放 PNG，不改变页面的视口或滚动位置。元素截图只包含视口里的部分；截屏前应先把目标滚动到可见区域。脚本显式要求截取视口以外的内容时仍使用浏览器的整页采集能力。

登录态由 Electron 的持久分区保存：桌面端共用一个 `persist:ego-default` 分区，登录一次之后跨任务空间、跨重启都保留，不需要导入旧 ego Profile 的 Cookie。任务空间仍各自持有页面，只是不再开独立 cookie jar；Web/CLI 保持按空间隔离。

下载走运行时原本的通道：端点把 `Browser.setDownloadBehavior`（以及旧版 `Page.setDownloadBehavior` 回退）记到页面宿主，页面发起的下载直接保存到运行时的临时目录，不弹系统保存框；开始与进度被翻译成 `Page.downloadWillBegin`、`Page.downloadProgress`，因此 `ego_download`／`page.waitForEvent('download')` 照常拿到文件路径。没有运行时指定目录时（页面自己触发的下载）落到系统下载目录，重名文件加 `(1)` 之类的后缀；只有运行时明确要求 `deny` 时才阻止下载。面板右上角有下载入口：进行中的数量显示在角标上，展开后按新到旧列出文件名、进度与状态，可取消进行中的下载、把已完成的文件另存到别处（系统保存对话框）、打开文件或显示所在文件夹；这些动作同样由主进程执行并在每次调用复核来源。

Web 与 CLI 不受影响：没有这个端点时运行时照旧启动本机 Edge、Chrome 或 Chromium，面板按会话订阅画面。桌面端当前不使用镜像帧流，因此采集与视频相关设置只在 Web/CLI 生效。

页面目录、活动历史与工具执行仍在 Host 侧，面板只取当前会话的页面并上报矩形。模型浏览器工具继续遵守会话审批和本机文件边界；Remote-SSH 工作区照常使用这个浏览器，只有上传、下载与本地 `file:///` 导航被拒绝。由 Host 运行时管理的页面记录跨工作台隐藏保留，关窗只撤下原生视图。不要将上游页面快照、调试输出或浏览器内部状态直接用作工作台文案。

## 打包与安装边界

`pnpm run build:desktop` 组装 `dist/Coding.app` macOS arm64 包，使用 `com.coding.desktop` bundle identifier。打包不会触碰 `/Applications/Coding.app`；只有调用 `make install` 才将新包安装到该路径，并替换已有应用。打包资源包含 Electron Framework、独立 Host runtime、Go helper 和 remote-agent；打包脚本核验 Host 生产闭包内的 `coding-browser-ego-host` 入口、浏览器运行时、采集 worker 与许可证／来源声明，不再要求 `coding-browser-electron`、Playwright JavaScript 包或另行捆绑 Chromium 浏览器。运行时仍需本机可用的 Edge、Chrome 或 Chromium。

本机包经 ad-hoc 深签名；`pnpm run test:electron:packaged` 在隔离 HOME 中直接运行 `.app`。该脚本的旧 guest 浏览器断言尚待迁移，更新前不能视为 ego 浏览器的验收；生产包的完整原生浏览器验证另行执行。生产配置使用已有 `~/.coding`（首次启动自动从 `~/.dsh` 迁移）与单独的 `~/.dsh-electron-user-data`；helper 在操作共享 Home 前取得安装版单实例锁，获锁失败时不得碰共享 Home。桌面 preload 的无凭据远程连接取消、单实例及退出清理可在原生冒烟更新后重验；原生菜单/托盘点击、真实外部模型请求和安装后运行仍不在该冒烟覆盖范围；Windows/Linux 原生运行尚未验证。
