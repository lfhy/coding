//go:build !windows

package remoteagent

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// configureCommand 为每个请求建立独立进程组，使取消能覆盖 bash 的子进程。
func configureCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcessTree(command *exec.Cmd) {
	if command.Process == nil {
		return
	}
	_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
}

// signalProcessTree 向 detached 进程组发送受限信号；进程组已消失时回退到
// 直接子进程，覆盖极短的退出竞态。
func signalProcessTree(command *exec.Cmd, signal string) error {
	if command.Process == nil {
		return nil
	}
	value, ok := processUnixSignal(signal)
	if !ok {
		return errors.New("remote process: unsupported signal")
	}
	err := syscall.Kill(-command.Process.Pid, value)
	if err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	if errors.Is(err, syscall.ESRCH) {
		if directErr := command.Process.Signal(value); directErr != nil && !errors.Is(directErr, os.ErrProcessDone) {
			return directErr
		}
	}
	return nil
}

func processUnixSignal(signal string) (syscall.Signal, bool) {
	switch signal {
	case "SIGTERM":
		return syscall.SIGTERM, true
	case "SIGKILL":
		return syscall.SIGKILL, true
	default:
		return 0, false
	}
}

func commandSignal(state *os.ProcessState) string {
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() {
		return ""
	}
	switch status.Signal() {
	case syscall.SIGABRT:
		return "SIGABRT"
	case syscall.SIGALRM:
		return "SIGALRM"
	case syscall.SIGBUS:
		return "SIGBUS"
	case syscall.SIGCHLD:
		return "SIGCHLD"
	case syscall.SIGCONT:
		return "SIGCONT"
	case syscall.SIGFPE:
		return "SIGFPE"
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGILL:
		return "SIGILL"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGIO:
		return "SIGIO"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGPIPE:
		return "SIGPIPE"
	case syscall.SIGPROF:
		return "SIGPROF"
	case syscall.SIGQUIT:
		return "SIGQUIT"
	case syscall.SIGSEGV:
		return "SIGSEGV"
	case syscall.SIGSTOP:
		return "SIGSTOP"
	case syscall.SIGSYS:
		return "SIGSYS"
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGTRAP:
		return "SIGTRAP"
	case syscall.SIGTSTP:
		return "SIGTSTP"
	case syscall.SIGTTIN:
		return "SIGTTIN"
	case syscall.SIGTTOU:
		return "SIGTTOU"
	case syscall.SIGURG:
		return "SIGURG"
	case syscall.SIGUSR1:
		return "SIGUSR1"
	case syscall.SIGUSR2:
		return "SIGUSR2"
	case syscall.SIGVTALRM:
		return "SIGVTALRM"
	case syscall.SIGWINCH:
		return "SIGWINCH"
	case syscall.SIGXCPU:
		return "SIGXCPU"
	case syscall.SIGXFSZ:
		return "SIGXFSZ"
	default:
		return ""
	}
}
