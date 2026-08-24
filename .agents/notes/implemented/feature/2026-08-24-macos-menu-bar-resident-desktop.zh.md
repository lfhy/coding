# Agent Note: macOS 菜单栏让 Coding 桌面会话可恢复

Status: implemented

[English](2026-08-24-macos-menu-bar-resident-desktop.md) | 中文

## Problem

Coding 的 macOS 窗口原来遵循普通关闭路径，即使用户只是想暂时收起界面也会结束桌面进程。隐藏的桌面会话需要一个始终可用的明确入口，以恢复已有窗口或结束应用。

## Decision

[`apps/desktop/main.go`](../../../../apps/desktop/main.go) 仅在 macOS 启用 `HideWindowOnClose`，并把文件菜单的 Cmd+W 动作标为“隐藏窗口”。[`apps/desktop/tray_darwin.m`](../../../../apps/desktop/tray_darwin.m) 用应用图标的非模板 22pt 副本创建唯一的 Cocoa `NSStatusItem`，填满标准状态项的可用高度。它的菜单可以显示或隐藏 Coding，并提供明确的“退出 Coding”动作；退出动作经由 `NSApplication`，因此 Wails 仍拥有关闭过程。

同一个原生显示帮助函数会解除应用隐藏、恢复最小化窗口并把 Wails 主窗口前置。状态项和两条单实例路径共用它，所以再次启动能够恢复被隐藏的会话。应用会在 Wails 前启动 `instance.Listener`，并等待 `OnStartup` 发布原生窗口后才处理激活请求。[`apps/desktop/tray_other.go`](../../../../apps/desktop/tray_other.go) 让没有该原生状态项的平台保持原有的关闭即退出行为。

托盘仍是桌面壳职责。回环 Host 和 Web Client 不获得托盘绑定或平台专用状态模型。[桌面标题栏手势与 Client 安全区](../bug-fix/2026-08-24-desktop-window-chrome-safe-area.md)仍是独立的窗口外壳决策。

## Alternatives considered

- **使用 Wails `TrayMenu`。** 不采用：当前固定的 Wails 版本定义了托盘菜单数据，却没有暴露应用层创建入口，因此桌面壳不能通过该 API 创建状态项。
- **保持关闭即退出，并依赖再次启动。** 不采用：它会结束可见桌面会话，也没有为有意暂时隐藏提供持续的菜单栏控制。
- **立即让所有桌面平台关闭即隐藏。** 不采用：当前只有 macOS 壳拥有原生恢复入口；其他平台在各自的托盘实现出现前保持既有关闭即退出行为。

## Consequences

在 macOS 上，红色关闭按钮和 Cmd+W 会隐藏 Coding，同时菜单栏图标仍可使用。“显示 Coding”恢复并聚焦已有窗口，“退出 Coding”结束桌面进程。Windows 及其他非 macOS 构建仍然正常关闭，不会在没有恢复入口时隐藏。

## Testing

`CGO_ENABLED=1 go test ./...` 会编译 Cocoa 桥接，并核对自定义单实例激活请求的投递。打包后的 `Coding.app` 会手动核对关闭到菜单栏、显示、隐藏、退出和再次启动恢复。
