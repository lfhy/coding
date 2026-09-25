//go:build darwin || linux

package sshfixture

import (
	"os/exec"
	"syscall"
)

// agent 自己发起的测试子进程也必须在 fixture 关闭时退出。
func prepareAgentProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func stopAgentProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Process.Kill()
	}
}
