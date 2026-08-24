#import <Cocoa/Cocoa.h>

static id codingWindowChromeMonitor = nil;

// 顶部空白区沿用标题栏双击行为，交通灯按钮保持自己的原生动作。
static BOOL isCodingTopChromeDoubleClick(NSEvent *event) {
    NSWindow *window = event.window;
    if (window == nil || window != NSApp.mainWindow || event.clickCount != 2) {
        return NO;
    }

    NSView *content = window.contentView;
    NSPoint point = [content convertPoint:event.locationInWindow fromView:nil];
    if (point.y < NSMaxY(content.bounds) - 40.0) {
        return NO;
    }

    for (NSWindowButton buttonType = NSWindowCloseButton;
         buttonType <= NSWindowZoomButton;
         buttonType++) {
        NSButton *button = [window standardWindowButton:buttonType];
        if (button != nil && NSPointInRect(event.locationInWindow, [button convertRect:button.bounds toView:nil])) {
            return NO;
        }
    }

    return YES;
}

void codingInstallWindowChrome(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (codingWindowChromeMonitor != nil) {
            return;
        }

        codingWindowChromeMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown
                                                                            handler:^NSEvent * _Nullable(NSEvent *event) {
            if (!isCodingTopChromeDoubleClick(event)) {
                return event;
            }
            [event.window zoom:nil];
            return nil;
        }];
    });
}
