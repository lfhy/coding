//go:build darwin

package main

import "testing"

func TestMacOSCloseWindowKeepsMenuBarRecovery(t *testing.T) {
	if !hideWindowOnClose() {
		t.Fatal("macOS close action must preserve the menu-bar recovery path")
	}
	if got, want := closeWindowMenuLabel(), "隐藏窗口"; got != want {
		t.Errorf("close menu label = %q, want %q", got, want)
	}
}
