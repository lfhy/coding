//go:build darwin || linux

package remoteagent

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// unixTerminalBackend 把一个新 session/controlling terminal 的主端交给会话层。
// pty.StartWithSize 在 macOS 与 Linux 上启动子进程时同时建立 setsid 和 ctty。
type unixTerminalBackend struct {
	file    *os.File
	command *exec.Cmd
	grace   time.Duration

	waited chan struct{}

	closeOnce     sync.Once
	terminateOnce sync.Once
	terminateErr  error
}

func startTerminalBackend(path string, request TerminalStartRequest) (terminalBackend, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fail(400, "not-directory", "terminal path is not a directory")
	}
	environment, err := terminalEnvironment(request.Env)
	if err != nil {
		return nil, err
	}
	executable, err := processLookPath(request.Argv[0], environment, path)
	if err != nil {
		return nil, err
	}
	command := exec.Command(executable, request.Argv[1:]...)
	command.Dir = path
	command.Env = environment
	file, err := pty.StartWithSize(command, &pty.Winsize{Rows: uint16(request.Rows), Cols: uint16(request.Cols)})
	if err != nil {
		if errors.Is(err, pty.ErrUnsupported) {
			return nil, ErrTerminalUnavailable
		}
		return nil, fmt.Errorf("remote terminal: start PTY: %w", err)
	}
	return &unixTerminalBackend{file: file, command: command, grace: terminalGrace(request), waited: make(chan struct{})}, nil
}

func (backend *unixTerminalBackend) Read(data []byte) (int, error) {
	return backend.file.Read(data)
}

func (backend *unixTerminalBackend) Write(data []byte) (int, error) {
	return backend.file.Write(data)
}

func (backend *unixTerminalBackend) Resize(cols, rows int) error {
	if err := validateTerminalSize(cols, rows); err != nil {
		return err
	}
	return pty.Setsize(backend.file, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}

func (backend *unixTerminalBackend) Close() error {
	var err error
	backend.closeOnce.Do(func() { err = backend.file.Close() })
	return err
}

func (backend *unixTerminalBackend) PID() int {
	if backend.command.Process == nil {
		return 0
	}
	return backend.command.Process.Pid
}

func (backend *unixTerminalBackend) Wait() terminalExit {
	err := backend.command.Wait()
	close(backend.waited)
	if backend.command.ProcessState == nil {
		return terminalExit{}
	}
	if signal := commandSignal(backend.command.ProcessState); signal != "" {
		return terminalExit{signal: signal}
	}
	if code := backend.command.ProcessState.ExitCode(); code >= 0 {
		return terminalExit{exitCode: &code}
	}
	// cmd.Wait 的底层错误在 ProcessState 缺失时才没有可序列化的退出事实；已经
	// 有 ProcessState 的正常非零退出仍应按 exitCode 交付。
	_ = err
	return terminalExit{}
}

func (backend *unixTerminalBackend) Foreground() (int, error) {
	connection, err := backend.file.SyscallConn()
	if err != nil {
		return 0, ErrTerminalNoForeground
	}
	var group int
	var ioctlErr error
	err = connection.Control(func(descriptor uintptr) {
		group, ioctlErr = unix.IoctlGetInt(int(descriptor), unix.TIOCGPGRP)
	})
	if err != nil || ioctlErr != nil || group <= 0 {
		return 0, ErrTerminalNoForeground
	}
	return group, nil
}

func (backend *unixTerminalBackend) SignalForeground(signal string) (int, error) {
	group, err := backend.Foreground()
	if err != nil {
		return 0, err
	}
	if signal == "SIGKILL" && group == backend.PID() {
		return 0, ErrTerminalRootKillRefused
	}
	value, valid := terminalUnixSignal(signal)
	if !valid {
		return 0, errors.New("remote terminal: unsupported foreground signal")
	}
	if err := unix.Kill(-group, value); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return 0, ErrTerminalNoForeground
		}
		return 0, err
	}
	return group, nil
}

func (backend *unixTerminalBackend) Terminate() error {
	backend.terminateOnce.Do(func() {
		backend.terminateErr = backend.signalSession(syscall.SIGTERM)
		if backend.terminateErr != nil {
			return
		}
		go func() {
			select {
			case <-backend.waited:
			case <-time.After(backend.grace):
				_ = backend.signalSession(syscall.SIGKILL)
			}
		}()
	})
	return backend.terminateErr
}

// ForceTerminate 在 agent 关闭的最终截止时间直接杀掉终端会话树。
func (backend *unixTerminalBackend) ForceTerminate() error {
	return backend.signalSession(syscall.SIGKILL)
}

func (backend *unixTerminalBackend) signalSession(signal syscall.Signal) error {
	select {
	case <-backend.waited:
		return nil
	default:
	}
	pid := backend.PID()
	if pid <= 0 {
		return nil
	}
	// 作业控制会把当前前台命令移入新的进程组；先向该组发送信号，再处理
	// shell 自己的组，避免只结束 shell 而遗留正在占用 PTY 的前台命令。
	if foreground, err := backend.Foreground(); err == nil && foreground != pid {
		if err := unix.Kill(-foreground, signal); err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
	}
	if err := unix.Kill(-pid, signal); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}

func terminalUnixSignal(value string) (syscall.Signal, bool) {
	switch value {
	case "SIGINT":
		return syscall.SIGINT, true
	case "SIGTERM":
		return syscall.SIGTERM, true
	case "SIGKILL":
		return syscall.SIGKILL, true
	case "SIGTSTP":
		return syscall.SIGTSTP, true
	case "SIGHUP":
		return syscall.SIGHUP, true
	default:
		return 0, false
	}
}

func terminalEnvironment(explicit map[string]string) ([]string, error) {
	environment, err := commandEnvironment(explicit)
	if err != nil {
		return nil, err
	}
	for _, entry := range environment {
		if strings.HasPrefix(entry, "TERM=") {
			return environment, nil
		}
	}
	return append(environment, "TERM=xterm-256color"), nil
}
