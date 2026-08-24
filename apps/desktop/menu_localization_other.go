//go:build !darwin

package main

// localizeNativeMenus 在非 macOS 平台不需要覆盖 Wails 的角色菜单文本。
func localizeNativeMenus() {}
