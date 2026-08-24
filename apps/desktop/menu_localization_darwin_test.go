//go:build darwin

package main

import (
	"reflect"
	"testing"
)

func TestNativeMenuTranslationsCoverWailsRoleMenus(t *testing.T) {
	want := map[string]string{
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
	if !reflect.DeepEqual(nativeMenuTranslations, want) {
		t.Errorf("native menu translations = %#v, want %#v", nativeMenuTranslations, want)
	}
}
