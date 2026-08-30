//go:build windows

package remoteagent

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

// configureCommand 创建独立 Windows 进程组；taskkill 随后终止完整子树。
func configureCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200}
}

func killProcessTree(command *exec.Cmd) {
	if command.Process == nil {
		return
	}
	err := exec.Command("taskkill", "/PID", strconv.Itoa(command.Process.Pid), "/T", "/F").Run()
	if err != nil {
		_ = command.Process.Kill()
	}
}

// Windows 不提供与 POSIX signal 等价的 ProcessState 分类。
func commandSignal(_ *os.ProcessState) string { return "" }
