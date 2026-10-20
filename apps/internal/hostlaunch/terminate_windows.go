//go:build windows

package hostlaunch

import (
	"os"

	"golang.org/x/sys/windows"
)

func ownedStopSignal() os.Signal { return os.Kill }

// terminateProcess 请求 Host 进程退出；权限不足或进程已消失时静默返回。
func terminateProcess(pid int) {
	if pid < 1 {
		return
	}
	process, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(process)
	_ = windows.TerminateProcess(process, 1)
}
