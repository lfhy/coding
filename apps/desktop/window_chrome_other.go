//go:build !darwin

package main

// installNativeWindowChrome 在非 macOS 平台没有额外的原生标题栏手势。
func installNativeWindowChrome() {}
