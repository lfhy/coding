# Agent Note: 通过合成的 Alt 按键让 Win32 选择器获得前台激活

Status: implemented

## Problem

原生 Win32 文件夹对话框运行在子进程中。后台宿主启动该进程时，Windows 可能将其首个窗口打开在前台应用之后，使操作者看不到目录选择器。

## Decision

`runFolderDialog` 在 `showing` 通知与阻塞式 `Show` 之间调用 `pressAltForForeground`。koffi 绑定以 `keybd_event` 合成一次 Alt 按键（`VK_MENU`，先按下后抬起）。Windows 将子进程认作最近的输入所有者，使 `Show` 可以将对话框激活到前台。每次 Windows 选择器调用都会执行该操作；子进程已具备前台权限时它没有实质作用，但焦点窗口的菜单栏可能会短暂高亮。

## Alternatives considered

**由浏览器发起前台授权。** 自定义协议或 `AllowSetForegroundWindow` 都要求前台浏览器参与，并会为本地选择器交互增加跨进程或注册表状态。

**AttachThreadInput。** 将对话框线程附着到焦点线程依赖另一个进程的线程与完整性级别，因此无法形成可靠的选择器契约。

## Consequences

选择器保留单一 spawn 子进程设计，并在 `Show` 紧前方增加两次 user32 调用。bindings 与时序测试固定 Alt 按下/抬起序列及其位于中止通知之后的顺序。安全桌面、受限 Remote-SSH 会话和已提权的前台窗口可能抑制注入的输入；此时原生选择器仍可能在其他窗口后面打开，包 README 已记录该限制。对于不适合宿主本地对话框的环境，browse 后端仍是组合层面的回退。
