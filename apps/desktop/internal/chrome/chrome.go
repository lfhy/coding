// Package chrome 提供桌面窗口的原生外观定制与页面安全区约定。
package chrome

import "unsafe"

// PageSafeAreaScript 返回注入到每个页面的安全区 CSS 变量脚本。
// 壳层负责给出平台一致的取值；页面用 --app-safe-area-inset-top 避让系统控件。
func PageSafeAreaScript() string {
	return "document.documentElement.style.setProperty('--app-safe-area-inset-top','" + safeAreaTop() + "');"
}

// Decorate 按平台调整窗口装饰；非 macOS 平台保持 webview 默认外观。
func Decorate(window interface{ Window() unsafe.Pointer }) {
	apply(window)
}
