//go:build windows

package remoteagent

import (
	"errors"
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

// signalProcessTree 在 Windows 上统一通过 taskkill 结束完整子树。Windows
// 没有可移植的 SIGTERM 语义，因此两种受限信号都采用立即树终止。
func signalProcessTree(command *exec.Cmd, signal string) error {
	if signal != "SIGTERM" && signal != "SIGKILL" {
		return syscall.EINVAL
	}
	if command.Process == nil {
		return nil
	}
	args := []string{"/PID", strconv.Itoa(command.Process.Pid), "/T", "/F"}
	if err := exec.Command("taskkill", args...).Run(); err != nil {
		if killErr := command.Process.Kill(); killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
			return killErr
		}
	}
	return nil
}

// Windows 不提供与 POSIX signal 等价的 ProcessState 分类。
func commandSignal(_ *os.ProcessState) string { return "" }
