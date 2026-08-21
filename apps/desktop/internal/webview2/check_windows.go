//go:build windows

// Package webview2 检测 Windows 目标上 WebView2 固定/常青运行时是否可加载。
package webview2

import (
	"golang.org/x/sys/windows"
)

// Check 探测 Loader 库与系统安装目录中是否存在 WebView2 运行时；仅诊断
// 可用性，不做安装引导。
func Check() error {
	if _, err := windows.LoadLibrary("WebView2Loader.dll"); err == nil {
		return nil
	}
	if _, err := windows.LoadLibraryEx("EBWebView.dll", 0, windows.LOAD_LIBRARY_SEARCH_SYSTEM32); err == nil {
		return nil
	}
	return windows.ERROR_FILE_NOT_FOUND
}
