//go:build windows

package main

import "golang.org/x/sys/windows"

// replaceMarkerFile 使用 Windows 的 replace-existing 语义原子更新 marker。
func replaceMarkerFile(source, destination string) error {
	from, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
