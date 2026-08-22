//go:build !darwin

package chrome

import "unsafe"

// apply 是非 macOS 平台的空实现。
func apply(window interface{ Window() unsafe.Pointer }) {}

// safeAreaTop 非 macOS 暂无系统控件浮层，返回零安全区。
func safeAreaTop() string { return "0px" }
