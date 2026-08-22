//go:build darwin

package chrome

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// styleWindow 在保留标题栏结构的前提下做成无边框观感：标题栏透明、标题隐藏，
// 窗口保持系统圆角与红绿灯按钮；内容区通过 safe-area inset 获得交通灯避让。
void styleWindow(void *window) {
	NSWindow *nsWindow = (__bridge NSWindow *)window;
	[nsWindow setStyleMask:([nsWindow styleMask] | NSWindowStyleMaskFullSizeContentView)];
	[nsWindow setTitlebarAppearsTransparent:YES];
	[nsWindow setTitleVisibility:NSWindowTitleHidden];
	[nsWindow setMovableByWindowBackground:YES];
}

// ensureMainMenu 补齐 macOS 应用菜单栏的基础项：应用、文件、编辑、视图、窗口、帮助。
// webview_go 不建菜单栏，无菜单时 Cmd+Q 等系统快捷键全部失效。
void ensureMainMenu(void) {
	NSMenu *bar = [[NSMenu alloc] init];
	NSMenuItem *appItem = [bar addItemWithTitle:@"Coding" action:nil keyEquivalent:@""];
	NSMenu *appMenu = [[NSMenu alloc] init];
	[appMenu addItemWithTitle:@"关于 Coding" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
	[appMenu addItem:[NSMenuItem separatorItem]];
	[appMenu addItemWithTitle:@"隐藏 Coding" action:@selector(hide:) keyEquivalent:@"h"];
	id hideOthers = [appMenu addItemWithTitle:@"隐藏其他" action:@selector(hideOtherApplications:) keyEquivalent:@"h"];
	[hideOthers setKeyEquivalentModifierMask:NSEventModifierFlagCommand | NSEventModifierFlagOption];
	[appMenu addItemWithTitle:@"显示全部" action:@selector(unhideAllApplications:) keyEquivalent:@""];
	[appMenu addItem:[NSMenuItem separatorItem]];
	[appMenu addItemWithTitle:@"退出 Coding" action:@selector(terminate:) keyEquivalent:@"q"];
	[appItem setSubmenu:appMenu];

	NSMenuItem *fileItem = [bar addItemWithTitle:@"文件" action:nil keyEquivalent:@""];
	NSMenu *fileMenu = [[NSMenu alloc] init];
	[fileMenu addItemWithTitle:@"新建窗口" action:@selector(newWindowForTab:) keyEquivalent:@"n"];
	[fileMenu addItemWithTitle:@"关闭窗口" action:@selector(performClose:) keyEquivalent:@"w"];
	[fileItem setSubmenu:fileMenu];

	NSMenuItem *editItem = [bar addItemWithTitle:@"编辑" action:nil keyEquivalent:@""];
	NSMenu *editMenu = [[NSMenu alloc] init];
	[editMenu addItemWithTitle:@"撤销" action:@selector(undo:) keyEquivalent:@"z"];
	[editMenu addItemWithTitle:@"重做" action:@selector(redo:) keyEquivalent:@"Z"];
	[editMenu addItem:[NSMenuItem separatorItem]];
	[editMenu addItemWithTitle:@"剪切" action:@selector(cut:) keyEquivalent:@"x"];
	[editMenu addItemWithTitle:@"复制" action:@selector(copy:) keyEquivalent:@"c"];
	[editMenu addItemWithTitle:@"粘贴" action:@selector(paste:) keyEquivalent:@"v"];
	[editMenu addItemWithTitle:@"全选" action:@selector(selectAll:) keyEquivalent:@"a"];
	[editItem setSubmenu:editMenu];

	NSMenuItem *viewItem = [bar addItemWithTitle:@"视图" action:nil keyEquivalent:@""];
	NSMenu *viewMenu = [[NSMenu alloc] init];
	id toggleToolbar = [viewMenu addItemWithTitle:@"显示工具栏" action:@selector(toggleToolbarShown:) keyEquivalent:@"t"];
	[toggleToolbar setKeyEquivalentModifierMask:NSEventModifierFlagCommand | NSEventModifierFlagOption];
	id fullscreen = [viewMenu addItemWithTitle:@"切换全屏" action:@selector(toggleFullScreen:) keyEquivalent:@"f"];
	[fullscreen setKeyEquivalentModifierMask:NSEventModifierFlagCommand | NSEventModifierFlagControl];
	[viewItem setSubmenu:viewMenu];

	NSMenuItem *windowItem = [bar addItemWithTitle:@"窗口" action:nil keyEquivalent:@""];
	NSMenu *windowMenu = [[NSMenu alloc] init];
	[windowMenu addItemWithTitle:@"最小化" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
	[windowMenu addItemWithTitle:@"缩放" action:@selector(performZoom:) keyEquivalent:@""];
	[windowMenu addItem:[NSMenuItem separatorItem]];
	[windowMenu addItemWithTitle:@"前置全部窗口" action:@selector(arrangeInFront:) keyEquivalent:@""];
	[windowItem setSubmenu:windowMenu];

	NSMenuItem *helpItem = [bar addItemWithTitle:@"帮助" action:nil keyEquivalent:@""];
	NSMenu *helpMenu = [[NSMenu alloc] init];
	[helpMenu addItemWithTitle:@"Coding 帮助" action:@selector(showHelp:) keyEquivalent:@""];
	[helpItem setSubmenu:helpMenu];

	[NSApp setMainMenu:bar];
}
*/
import "C"

import "unsafe"

// apply 修改 NSWindow 样式并返回交通灯高度对应的顶部安全区。
func apply(window interface{ Window() unsafe.Pointer }) {
	C.ensureMainMenu()
	if handle := window.Window(); handle != nil {
		C.styleWindow(handle)
	}
}

// safeAreaTop 返回 macOS 交通灯占用的顶部安全区高度。
func safeAreaTop() string { return "38px" }
