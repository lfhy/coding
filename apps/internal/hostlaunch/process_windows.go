//go:build windows

package hostlaunch

import (
	"golang.org/x/sys/windows"
)

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(process)
	var code uint32
	if windows.GetExitCodeProcess(process, &code) != nil {
		return false
	}
	return code == 259 // STILL_ACTIVE is the Win32 process-status sentinel.
}
