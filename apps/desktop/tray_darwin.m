#import <Cocoa/Cocoa.h>

static NSStatusItem *codingStatusItem = nil;
static id codingTrayTarget = nil;

@interface CodingTrayTarget : NSObject
- (void)showWindow:(id)sender;
- (void)hideWindow:(id)sender;
- (void)quitApplication:(id)sender;
@end

// 主窗口在应用隐藏后不再是 key window，按普通窗口候选查找可恢复同一个 Wails 窗口。
static NSWindow *codingPrimaryWindow(void) {
    NSWindow *window = NSApp.mainWindow;
    if (window != nil) {
        return window;
    }

    window = NSApp.keyWindow;
    if (window != nil) {
        return window;
    }

    for (NSWindow *candidate in NSApp.windows) {
        if (![candidate isKindOfClass:NSPanel.class]) {
            return candidate;
        }
    }

    return nil;
}

// 从菜单栏、Dock 或单实例请求恢复时，取消隐藏并重新激活 Wails 主窗口。
static void codingShowPrimaryWindowOnMainThread(void) {
    [NSApp unhide:nil];

    NSWindow *window = codingPrimaryWindow();
    if (window != nil) {
        [window deminiaturize:nil];
        [window makeKeyAndOrderFront:nil];
    }

    [NSApp activateIgnoringOtherApps:YES];
}

@implementation CodingTrayTarget

- (void)showWindow:(id)sender {
    codingShowPrimaryWindowOnMainThread();
}

- (void)hideWindow:(id)sender {
    [NSApp hide:nil];
}

- (void)quitApplication:(id)sender {
    // 经 AppDelegate 转给 Wails，确保 OnShutdown 与 Host 清理照常发生。
    [NSApp terminate:nil];
}

@end

// codingTrayImage 复用应用图标，并填满标准状态项的可用高度。
static NSImage *codingTrayImage(void) {
    NSImage *source = NSApp.applicationIconImage;
    NSImage *image = [source copy];
    [image setSize:NSMakeSize(22.0, 22.0)];
    [image setTemplate:NO];
    return [image autorelease];
}

void codingInstallTray(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (codingStatusItem != nil) {
            return;
        }

        codingTrayTarget = [[CodingTrayTarget alloc] init];
        codingStatusItem = [[[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength] retain];

        NSStatusBarButton *button = codingStatusItem.button;
        [button setImage:codingTrayImage()];
        [button setToolTip:@"Coding"];

        NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Coding"];
        NSMenuItem *showItem = [menu addItemWithTitle:@"显示 Coding" action:@selector(showWindow:) keyEquivalent:@""];
        [showItem setTarget:codingTrayTarget];
        NSMenuItem *hideItem = [menu addItemWithTitle:@"隐藏 Coding" action:@selector(hideWindow:) keyEquivalent:@""];
        [hideItem setTarget:codingTrayTarget];
        [menu addItem:[NSMenuItem separatorItem]];
        NSMenuItem *quitItem = [menu addItemWithTitle:@"退出 Coding" action:@selector(quitApplication:) keyEquivalent:@""];
        [quitItem setTarget:codingTrayTarget];
        [codingStatusItem setMenu:menu];
        [menu release];
    });
}

void codingRemoveTray(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (codingStatusItem != nil) {
            [[NSStatusBar systemStatusBar] removeStatusItem:codingStatusItem];
            [codingStatusItem release];
            codingStatusItem = nil;
        }
        [codingTrayTarget release];
        codingTrayTarget = nil;
    });
}

void codingShowPrimaryWindow(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        codingShowPrimaryWindowOnMainThread();
    });
}

void codingHidePrimaryWindow(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp hide:nil];
    });
}
