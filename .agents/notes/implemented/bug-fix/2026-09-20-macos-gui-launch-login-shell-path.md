# Agent Note: macOS GUI 启动的 Host 使用登录 shell 的 PATH

Status: implemented

## 问题

从 Finder、Dock 或 LaunchServices 启动 `Coding.app` 时，应用进程由 launchd 直接启动，继承的 PATH 只有
`/usr/bin:/bin:/usr/sbin:/sbin`。启动器把这整份环境交给 Host，bash 工具再传给模型执行的命令，于是 Homebrew、nvm、
Go、cargo 等目录里的可执行文件全部不可见：`make codex-pro-install` 这类构建在 `/bin/sh: go: command not found`
处失败，模型必须先 `export PATH=/usr/local/go/bin:$PATH` 才能继续。

用户终端里的 PATH 由登录 shell 的启动配置拼出：`/etc/zprofile` 的 `path_helper` 读 `/etc/paths.d`（Go 即由此加入），
`.zprofile` 加 `~/go/bin`，`.zshrc` 加 Homebrew、nvm、cargo 等。GUI 启动不读取这些配置，同一个应用与用户终端因此
看到不同的可执行文件搜索路径。

## 决策

`apps/internal/hostlaunch` 在构造 Host 子进程环境时补全 PATH：在 macOS 上、且本进程由 launchd 直接启动
（`os.Getppid() == 1`）时，用交互式登录 shell（`$SHELL -ilc`）展开出的 PATH 替换继承的 PATH。从终端启动时父进程
不是 launchd，继承的 PATH 已经来自用户 shell，保持原值；`SHELL` 缺失、探测失败或超时同样保留继承环境。

- **交互 + 登录模式**：`.zshrc` 提供 Homebrew、nvm、cargo，`/etc/zprofile` 与 `.zprofile` 提供 path_helper 目录与
  `~/go/bin`；只取其中一种模式都会漏掉一半用户目录。
- **标记行解析**：探测命令输出 `__DSH_LOGIN_SHELL_PATH__` 前缀的行，取最后一个；用户启动配置打印的横幅或插件消息
  不会混进结果。
- **探测环境清洗**：探测沿用继承环境，但剔除凭据形状的名字与 `DSH_*`，与 subprocess seam 对模型命令的清洗规则一致
  （见[防御模式](../../../../docs/defensive-patterns.md)）；用户启动配置看不到窗口私有的 bridge token。
- **超时回退**：探测有 6 秒上限；超时、退出非零或没有标记行时保留继承的 PATH，GUI 启动不会因为用户 shell 配置挂起
  而停住。
- **显式优先**：调用方仍可用 `Options.Environment` 传入 PATH 覆盖探测结果；`DSH_HOME`、`DSH_CWD`、`DSH_APP_VERSION`
  继续由启动器独占。

非 macOS 平台不补全：Windows 与 Linux 的桌面进程继承系统会话环境，PATH 不依赖 shell 启动配置。补全只影响 GUI
启动的 Host 及其后代（bash 工具、hooks、MCP 客户端、subagent），不影响从终端启动的 CLI、TUI 与开发模式。启动器与
Host 的关系见 [Go 客户端共享 Node Host 提案](../../proposed/architecture/2026-08-20-coding-go-clients-shared-node-host.md)。

## 曾考虑的替代方案

**用 `/usr/libexec/path_helper` 补全系统目录。** 它能通过 `/etc/paths.d/go` 找回 Go，但读不到 `~/.zshrc` 里的
Homebrew、nvm、cargo 和用户的 PATH 定制，命令与用户终端仍不一致；同一类故障只是缩小了范围。

**在 `Info.plist` 的 `LSEnvironment` 里写死 PATH。** 只在 LaunchServices 启动时生效，目录列表还是静态硬编码，用户
换 Homebrew 前缀或调整 PATH 后会再次失效。

**在 Host（TypeScript）侧解析登录 shell。** CLI 从终端启动时 PATH 已经正确，在 Host 里探测会给每次启动增加一次 shell
启动开销，并且与启动器已有的子进程环境所有权重复。只有启动器知道本次是 GUI 启动还是终端启动。

**不做区分，每次启动都替换 PATH。** 从终端启动时替换会覆盖用户为这次启动显式设置的 PATH（例如临时切换 Node 版本），
而这两种启动方式可以用父进程事实可靠区分。

## 后果

- 桌面端从 Finder 或 Dock 启动后，模型执行的命令与用户终端看到同一组可执行文件目录，不再需要模型手工导出 PATH。
- 首次探测要启动一次用户 shell（本机 zsh 含 nvm 约 1.5 秒），在进程内只做一次，发生在窗口就绪后的 Host 启动路径上；
  启动配置挂起时最多等待 6 秒后回退。
- 用户 shell 配置从此进入 Host 启动路径：启动配置在非交互环境下若行为异常（例如等待输入），其 PATH 结果会被丢弃
  而不是阻塞启动。
- 覆盖范围限于 macOS GUI 启动；终端启动的 PATH 仍由调用方的环境决定，不做二次加工。
