# Agent Note: macOS 选择器改用进程内文件夹面板

Status: implemented

[English](2026-09-22-macos-picker-in-process-panel.md) | 中文

## Problem

macOS 层级此前通过 `osascript` 请求 AppleScript 的 `choose folder` 对话框。该面板由无 bundle 的 `osascript` 进程自行呈现；当宿主作为桌面壳的后台子进程运行时，面板窗口只会被创建而不会进入任何显示器：失败时用窗口列表探针观察，可以看到该选择器窗口归属负责应用、`kCGWindowIsOnscreen` 为 false，因此没有任何点击能结束这次模态循环。调用方一直等到 AppleEvent 超时，选择以 `-1712`（`AppleEvent timed out`）失败，GUI 将其呈现为可重试的目录选择错误。

## Decision

darwin 分支改为执行 `osascript -l JavaScript`，由 JXA 脚本在进程内构造 `NSOpenPanel`：允许选择目录、关闭文件与多选、沿用 `Select Workspace Directory` 提示文本，采用 `accessory` 激活策略并调用 `activateIgnoringOtherApps`，最后阻塞在 `runModal`。面板因此走会话中普通的 AppKit 呈现路径，能够上屏并接受输入；探针显示它以上浮层级出现在屏幕上，而 AppleScript 形式始终不可见。脚本返回所选路径；`runModal` 的返回值只要不是 `NSModalResponseOK` 就返回空串，由 `outputPath` 折叠为 `null` 取消。

该层级仍为单层且没有回退：JXA 或 osascript 的失败按进程自身的退出码与 stderr 上报，调用方的中止仍然会终止进程。

## Alternatives considered

**保留 `choose folder` 并放宽 AppleScript 超时（`with timeout of N seconds`）。** 拒绝：面板根本不会上屏，放宽超时只是推迟同一个失败。

**在 AppleScript 命令前后激活负责应用。** 拒绝：这次失败不只是焦点顺序问题——面板窗口从未被排上屏幕——而通常的做法（`tell application "System Events"`）会为一次本地目录选择引入 Automation 授权提示。

**由桌面壳通过 Wails 绑定呈现文件夹面板。** 拒绝：`host.pickDirectory` 同时服务浏览器与 CLI 载体，只走桌面壳会让原生层级在其他载体上继续失效，并在 seam 的单一后端之外再增加一条选择路径。

## Consequences

- darwin 分支不再保留 `-128`／`User canceled` 的 stderr 判据：取消表现为空结果，命令失败一律原样上报。
- `tests/native-picker.spec.ts` 固定 JXA 参数与空输出取消；畸形错误用例改为针对 Linux 层级，该层级仍按退出码判定取消。
- 重新引入条件：若出现一种会自行从后台进程上屏的系统文件夹选择器，JXA 桥就失去理由；在此之前 `choose folder` 不再使用。
