//go:build darwin

package chrome

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// styleWindow 将 NSWindow 切换为无边框等价样式：隐藏标题栏，
// 保留全尺寸内容视图与系统拖拽区，使 Web 页面铺满整个窗口。
void styleWindow(void *window) {
	NSWindow *nsWindow = (__bridge NSWindow *)window;
	[nsWindow setStyleMask:NSWindowStyleMaskFullSizeContentView];
	[nsWindow setTitlebarAppearsTransparent:YES];
	[nsWindow setTitleVisibility:NSWindowTitleHidden];
	[nsWindow setMovableByWindowBackground:YES];
}
*/
import "C"

import "unsafe"

// apply 修改 NSWindow 样式为全尺寸内容视图（无边框观感），保留系统拖拽区。
func apply(window interface{ Window() unsafe.Pointer }) {
	if handle := window.Window(); handle != nil {
		C.styleWindow(handle)
	}
}
