// Package chrome 提供桌面窗口的原生外观定制，当前实现 macOS 无边框窗口。
package chrome

import "unsafe"

// Decorate 按平台调整窗口装饰；非 macOS 平台保持 webview 默认外观。
func Decorate(window interface{ Window() unsafe.Pointer }) {
	apply(window)
}
