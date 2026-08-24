//go:build !darwin

package main

import (
	"context"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// hideWindowOnClose 只在已有菜单栏恢复入口的平台启用关闭即隐藏。
func hideWindowOnClose() bool {
	return false
}

// closeWindowMenuLabel 保留没有原生状态项平台的关闭菜单语义。
func closeWindowMenuLabel() string {
	return "关闭窗口"
}

// installNativeTray 在非 macOS 平台没有原生状态项。
func installNativeTray() {}

// removeNativeTray 在非 macOS 平台无需清理状态项。
func removeNativeTray() {}

// showPrimaryWindow 恢复并显示主窗口。
func showPrimaryWindow(ctx context.Context) {
	wailsruntime.WindowUnminimise(ctx)
	wailsruntime.WindowShow(ctx)
}

// closePrimaryWindow 保留没有原生状态项平台的退出语义。
func closePrimaryWindow(ctx context.Context) {
	wailsruntime.Quit(ctx)
}
