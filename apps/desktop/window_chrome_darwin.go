//go:build darwin

package main

/*
#cgo LDFLAGS: -framework AppKit
void codingInstallWindowChrome(void);
*/
import "C"

// installNativeWindowChrome 由原生窗口层处理标题栏手势，避免 Host 页面来源校验影响窗口控制。
func installNativeWindowChrome() {
	C.codingInstallWindowChrome()
}
