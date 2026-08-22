//go:build darwin

package chrome

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// styleWindow 在保留标题栏结构的前提下做成无边框观感：标题栏透明、标题隐藏，
// 窗口保持系统圆角与红绿灯按钮，Web 页面铺满全尺寸内容视图。
void styleWindow(void *window) {
	NSWindow *nsWindow = (__bridge NSWindow *)window;
	[nsWindow setStyleMask:([nsWindow styleMask] | NSWindowStyleMaskFullSizeContentView)];
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
