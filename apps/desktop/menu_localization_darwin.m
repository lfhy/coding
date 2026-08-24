#import <Cocoa/Cocoa.h>

static void codingLocalizeMenu(NSMenu *menu, NSDictionary<NSString *, NSString *> *translations) {
    NSString *menuTitle = translations[menu.title];
    if (menuTitle != nil) {
        [menu setTitle:menuTitle];
    }

    for (NSMenuItem *item in menu.itemArray) {
        NSString *itemTitle = translations[item.title];
        if (itemTitle != nil) {
            [item setTitle:itemTitle];
        }
        if (item.submenu != nil) {
            codingLocalizeMenu(item.submenu, translations);
        }
    }
}

void codingLocalizeNativeMenus(const char *translationsJSON) {
    NSData *data = [NSData dataWithBytes:translationsJSON length:strlen(translationsJSON)];
    NSError *error = nil;
    NSDictionary<NSString *, NSString *> *translations = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if (translations == nil || error != nil) {
        return;
    }

    [translations retain];
    dispatch_async(dispatch_get_main_queue(), ^{
        codingLocalizeMenu(NSApp.mainMenu, translations);
        [translations release];
    });
}
