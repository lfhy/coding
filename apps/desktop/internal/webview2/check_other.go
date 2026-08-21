//go:build !windows

// Package webview2 在非 Windows 目标上为空实现：WKWebView 由系统提供。
package webview2

import "errors"

// Check 恒为 nil；仅 Windows 需要 WebView2 运行时检测。
func Check() error { return errors.New("webview2 check is windows-only") }
