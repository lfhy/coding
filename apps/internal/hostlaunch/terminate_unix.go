//go:build !windows

package hostlaunch

import (
	"os"
	"syscall"
)

// terminateProcess 向 Host 进程发送常规停止信号；权限不足或进程已消失时静默返回。
func terminateProcess(pid int) {
	if pid < 1 {
		return
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	_ = process.Signal(syscall.SIGTERM)
}
