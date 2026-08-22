//go:build !darwin

package chrome

import "unsafe"

// apply 是非 macOS 平台的空实现。
func apply(window interface{ Window() unsafe.Pointer }) {}
