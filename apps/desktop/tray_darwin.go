//go:build darwin

package main

/*
#cgo LDFLAGS: -framework AppKit
void codingInstallTray(void);
void codingRemoveTray(void);
void codingShowPrimaryWindow(void);
void codingHidePrimaryWindow(void);
*/
import "C"

import "context"

// hideWindowOnClose 让交通灯关闭动作隐藏到菜单栏，进程和 Host 保持运行。
func hideWindowOnClose() bool {
	return true
}

// closeWindowMenuLabel 明确 Cmd+W 在 macOS 仅隐藏到菜单栏。
func closeWindowMenuLabel() string {
	return "隐藏窗口"
}

// installNativeTray 在 macOS 菜单栏创建 Coding 入口。
func installNativeTray() {
	C.codingInstallTray()
}

// removeNativeTray 在进程退出时释放菜单栏图标。
func removeNativeTray() {
	C.codingRemoveTray()
}

// showPrimaryWindow 解除应用隐藏、恢复最小化窗口并聚焦主窗口。
func showPrimaryWindow(context.Context) {
	C.codingShowPrimaryWindow()
}

// closePrimaryWindow 隐藏整个应用，保留菜单栏状态项作为恢复入口。
func closePrimaryWindow(context.Context) {
	C.codingHidePrimaryWindow()
}
