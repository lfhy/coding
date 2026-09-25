//go:build !darwin && !linux

package sshfixture

import "os/exec"

func prepareAgentProcess(_ *exec.Cmd) {}

func stopAgentProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
