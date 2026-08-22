//go:build darwin

package chrome

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

// codingNewSessionHook 由 Go 侧注册；菜单项触发时回到 Go 再驱动 WebView。
typedef void (*codingNewSessionFunc)(void);
static codingNewSessionFunc codingNewSessionHook = 0;

void codingNewSessionCallback(void);

// codingNewSessionBridge 是固定桥，转发到 Go 回调；enable/disable 由 Go 调用。
// 全部函数保持 static：//export 会让 cgo 把预备代码复制进两个生成文件，
// 非 static 定义会在链接期重复。
static void codingNewSessionBridge(void) {
	codingNewSessionCallback();
}
static void enableCodingNewSessionHook(void) {
	codingNewSessionHook = &codingNewSessionBridge;
}
static void disableCodingNewSessionHook(void) {
	codingNewSessionHook = 0;
}

// styleWindow 在保留标题栏结构的前提下做成无边框观感：标题栏透明、标题隐藏，
// 窗口保持系统圆角与红绿灯按钮；内容区通过 safe-area inset 获得交通灯避让。
static void styleWindow(void *window) {
	NSWindow *nsWindow = (__bridge NSWindow *)window;
	[nsWindow setStyleMask:([nsWindow styleMask] | NSWindowStyleMaskFullSizeContentView)];
	[nsWindow setTitlebarAppearsTransparent:YES];
	[nsWindow setTitleVisibility:NSWindowTitleHidden];
	[nsWindow setMovableByWindowBackground:YES];
}

// codingMenuNewSession 是菜单动作目标：有回调就执行新建会话。
static void codingMenuNewSession(id sender) {
	if (codingNewSessionHook != 0) codingNewSessionHook();
}

// codingMenuTarget 返回共享的动作目标对象，使菜单项成为有效可点击状态。
static id codingMenuTarget(void) {
	static id target = nil;
	if (target == nil) {
		target = [[NSObject alloc] init];
		class_addMethod(object_getClass(target), @selector(newSession:), (IMP)codingMenuNewSession, "v@:@");
	}
	return target;
}

// ensureMainMenu 补齐 macOS 应用菜单栏的基础项：应用、文件、编辑、视图、窗口、帮助。
// webview_go 不建菜单栏，无菜单时 Cmd+Q 等系统快捷键全部失效。
static void ensureMainMenu(void) {
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
	NSMenuItem *newSessionItem = [fileMenu addItemWithTitle:@"新建会话" action:@selector(newSession:) keyEquivalent:@"n"];
	[newSessionItem setTarget:codingMenuTarget()];
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

var newSessionCallback func()

//export codingNewSessionCallback
func codingNewSessionCallback() {
	if newSessionCallback != nil {
		newSessionCallback()
	}
}

// OnNewSession 注册菜单“新建会话”动作的 Go 回调；传 nil 注销。
func OnNewSession(hook func()) {
	newSessionCallback = hook
	if hook == nil {
		C.disableCodingNewSessionHook()
		return
	}
	C.enableCodingNewSessionHook()
}
func apply(window interface{ Window() unsafe.Pointer }) {
	C.ensureMainMenu()
	if handle := window.Window(); handle != nil {
		C.styleWindow(handle)
	}
}

// safeAreaTop 返回 macOS 交通灯占用的顶部安全区高度。
func safeAreaTop() string { return "38px" }
