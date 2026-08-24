//go:build !darwin

package main

import "testing"

func TestOtherPlatformsKeepCloseToQuit(t *testing.T) {
	if hideWindowOnClose() {
		t.Fatal("platform without a native tray must not hide when closed")
	}
	if got, want := closeWindowMenuLabel(), "关闭窗口"; got != want {
		t.Errorf("close menu label = %q, want %q", got, want)
	}
}
