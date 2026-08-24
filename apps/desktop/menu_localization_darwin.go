//go:build darwin

package main

/*
#cgo LDFLAGS: -framework AppKit
#include <stdlib.h>
void codingLocalizeNativeMenus(const char *translationsJSON);
*/
import "C"

import (
	"encoding/json"
	"unsafe"
)

// nativeMenuTranslations 覆盖 Wails 预设角色菜单中写死的英文显示文本。
var nativeMenuTranslations = map[string]string{
	"About Coding":          "关于 Coding",
	"Hide Coding":           "隐藏 Coding",
	"Hide Others":           "隐藏其他应用",
	"Show All":              "显示全部",
	"Quit Coding":           "退出 Coding",
	"Edit":                  "编辑",
	"Undo":                  "撤销",
	"Redo":                  "重做",
	"Cut":                   "剪切",
	"Copy":                  "复制",
	"Paste":                 "粘贴",
	"Paste and Match Style": "粘贴并匹配样式",
	"Delete":                "删除",
	"Select All":            "全选",
	"Speech":                "朗读",
	"Start Speaking":        "开始朗读",
	"Stop Speaking":         "停止朗读",
	"Window":                "窗口",
	"Minimize":              "最小化",
	"Zoom":                  "缩放",
	"Full Screen":           "全屏",
}

// localizeNativeMenus 把文本目录交给 macOS 原生菜单层，角色菜单的选择器与快捷键保持不变。
func localizeNativeMenus() {
	translationsJSON, err := json.Marshal(nativeMenuTranslations)
	if err != nil {
		panic("编码原生菜单翻译失败: " + err.Error())
	}
	encoded := C.CString(string(translationsJSON))
	defer C.free(unsafe.Pointer(encoded))
	C.codingLocalizeNativeMenus(encoded)
}
