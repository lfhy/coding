//go:build darwin || linux

package sshfixture

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/crypto/ssh"
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

func resizeFixtureTerminal(terminal *fixtureTerminal) error {
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	if terminal.file == nil {
		return errors.New("fixture PTY is closed")
	}
	return pty.Setsize(terminal.file, &pty.Winsize{Cols: terminal.cols, Rows: terminal.rows})
}

func fixtureSignal(cmd *exec.Cmd, name string) bool {
	if cmd.Process == nil {
		return false
	}
	var signal syscall.Signal
	switch name {
	case "INT":
		signal = syscall.SIGINT
	case "TERM":
		signal = syscall.SIGTERM
	case "HUP":
		signal = syscall.SIGHUP
	case "QUIT":
		signal = syscall.SIGQUIT
	case "KILL":
		signal = syscall.SIGKILL
	case "WINCH":
		signal = syscall.SIGWINCH
	case "CONT":
		signal = syscall.SIGCONT
	default:
		return false
	}
	return syscall.Kill(-cmd.Process.Pid, signal) == nil
}

// directSession 仅启动经过完整摘要比对的 basic 固定脚本。此测试回环机并非
// 任意用户命令的沙箱：密码只交给隔离的测试进程，HOME/工作目录局限于临时根。
func (s *Server) directSession(stream ssh.Channel, command string, terminal *fixtureTerminal) (*exec.Cmd, <-chan uint32, error) {
	quoted := strings.TrimSuffix(strings.TrimPrefix(command, "bash -c '"), "'")
	script := strings.ReplaceAll(quoted, "'\\''", "'")
	cmd := exec.CommandContext(s.ctx, "/bin/bash", "-c", script)
	cmd.Dir = s.root
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + s.root, "LANG=C", "LC_ALL=C"}
	var stdin io.WriteCloser
	if terminal == nil {
		prepareAgentProcess(cmd)
		pipe, err := cmd.StdinPipe()
		if err != nil {
			return nil, nil, err
		}
		stdin = pipe
		cmd.Stdout = stream
		cmd.Stderr = stream.Stderr()
	}
	s.mu.Lock()
	if s.stopping || s.ctx.Err() != nil {
		s.mu.Unlock()
		return nil, nil, context.Canceled
	}
	var err error
	if terminal != nil {
		terminal.mu.Lock()
		terminal.file, err = pty.StartWithSize(cmd, &pty.Winsize{Cols: terminal.cols, Rows: terminal.rows})
		terminal.mu.Unlock()
	} else {
		err = cmd.Start()
	}
	if err != nil {
		s.mu.Unlock()
		return nil, nil, err
	}
	s.agents[cmd] = struct{}{}
	s.mu.Unlock()
	var outputDone <-chan struct{}
	if terminal != nil {
		terminal.mu.Lock()
		file := terminal.file
		terminal.mu.Unlock()
		stdin = file
		finished := make(chan struct{})
		outputDone = finished
		go func() { _, _ = io.Copy(stream, file); close(finished) }()
	}
	go func() {
		if err := s.copyScopedFixtureInput(stdin, stream, script); err != nil {
			stopAgentProcess(cmd)
		}
		if terminal == nil {
			_ = stdin.Close()
		}
	}()
	done := make(chan uint32, 1)
	go func() {
		err := cmd.Wait()
		status := uint32(0)
		if err != nil {
			status = 1
			var exited *exec.ExitError
			if errors.As(err, &exited) && exited.ExitCode() >= 0 {
				status = uint32(exited.ExitCode())
			}
		}
		if terminal != nil {
			// 正常退出先排空 PTY；若子孙进程仍占着 slave，限时关闭主端。
			select {
			case <-outputDone:
			case <-time.After(200 * time.Millisecond):
			}
			terminal.mu.Lock()
			_ = terminal.file.Close()
			terminal.file = nil
			terminal.mu.Unlock()
			<-outputDone
		}
		s.mu.Lock()
		delete(s.agents, cmd)
		s.mu.Unlock()
		done <- status
	}()
	return cmd, done, nil
}

func (s *Server) copyScopedFixtureInput(destination io.Writer, source io.Reader, script string) error {
	reader := bufio.NewReader(source)
	var frame bytes.Buffer
	field := func() (string, error) {
		for frame.Len() <= 512<<10 {
			value, err := reader.ReadByte()
			if err != nil {
				return "", err
			}
			if err := frame.WriteByte(value); err != nil {
				return "", err
			}
			if value == 0 {
				part := frame.Bytes()
				start := len(part) - 2
				for start >= 0 && part[start] != 0 {
					start--
				}
				if len(part)-start > 64<<10 {
					return "", errors.New("fixture frame field too large")
				}
				return string(part[start+1 : len(part)-1]), nil
			}
		}
		return "", errors.New("fixture frame too large")
	}
	root, err := field()
	if err != nil {
		return err
	}
	cwd, err := field()
	if err != nil {
		return err
	}
	if root != "" && filepath.Clean(root) != s.root {
		return errors.New("fixture root mismatch")
	}
	if !filepath.IsAbs(cwd) {
		return errors.New("fixture cwd must be absolute")
	}
	physical, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(s.root, physical)
	if err != nil || !filepath.IsLocal(rel) && rel != "." {
		return errors.New("fixture cwd outside temporary root")
	}
	if _, err := field(); err != nil {
		return err
	} // exec command 或 argv count
	kind := fixtureScriptKind(script)
	if kind == fixtureBootstrapUnknown {
		return errors.New("fixture bootstrap is not allowed")
	}
	if kind == fixtureBootstrapExec {
		if _, err := field(); err != nil {
			return err
		} // exec env count
	} else {
		// process/terminal 先取 argv，再取环境条目数。
		part := frame.Bytes()
		previous := bytes.LastIndexByte(part[:len(part)-1], 0)
		count, err := strconv.Atoi(string(part[previous+1 : len(part)-1]))
		if err != nil || count < 1 || count > 128 {
			return errors.New("fixture argv count invalid")
		}
		for range count {
			if _, err := field(); err != nil {
				return err
			}
		}
		if _, err := field(); err != nil {
			return err
		}
	}
	part := frame.Bytes()
	previous := bytes.LastIndexByte(part[:len(part)-1], 0)
	count, err := strconv.Atoi(string(part[previous+1 : len(part)-1]))
	if err != nil || count < 0 || count > 128 {
		return errors.New("fixture environment count invalid")
	}
	for range count {
		if _, err := field(); err != nil {
			return err
		}
		if kind == fixtureBootstrapProcess || kind == fixtureBootstrapResolve {
			present, err := field()
			if err != nil || present != "0" && present != "1" {
				return errors.New("fixture environment presence invalid")
			}
			if present == "0" {
				continue
			}
		}
		if _, err := field(); err != nil {
			return err
		}
	}
	if _, err := io.Copy(destination, bytes.NewReader(frame.Bytes())); err != nil {
		return err
	}
	_, _ = io.Copy(destination, reader)
	return nil
}
