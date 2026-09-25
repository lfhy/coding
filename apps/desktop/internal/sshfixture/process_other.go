//go:build !darwin && !linux

package sshfixture

import (
	"errors"
	"os/exec"

	"golang.org/x/crypto/ssh"
)

func prepareAgentProcess(_ *exec.Cmd) {}

func stopAgentProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func resizeFixtureTerminal(*fixtureTerminal) error { return errors.New("fixture PTY is unavailable") }
func fixtureSignal(*exec.Cmd, string) bool         { return false }
func (s *Server) directSession(ssh.Channel, string, *fixtureTerminal) (*exec.Cmd, <-chan uint32, error) {
	return nil, nil, errors.New("fixture direct sessions require POSIX")
}
