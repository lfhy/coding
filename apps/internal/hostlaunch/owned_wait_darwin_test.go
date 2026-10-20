//go:build darwin

package hostlaunch

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestOwnedExitChildProcess(t *testing.T) {
	if os.Getenv("HOSTLAUNCH_EXIT_CHILD") != "1" {
		return
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
	os.Exit(0)
}

func TestObserveOwnedProcessExitPrecedesReaping(t *testing.T) {
	command, input := ownedExitTestChild(t)
	observe, err := observeOwnedProcessExit(command.Process)
	if err != nil {
		t.Fatal(err)
	}
	_ = input.Close()
	observed := make(chan struct{})
	go func() { observe(); close(observed) }()
	select {
	case <-observed:
	case <-time.After(3 * time.Second):
		t.Fatal("NOTE_EXIT did not observe the original child's exit")
	}
	info, err := unix.SysctlKinfoProc("kern.proc.pid", command.Process.Pid)
	if err != nil || info.Proc.P_stat != 5 {
		t.Fatalf("exit observer reaped the child: info = %#v, error = %v", info, err)
	}
	owned := &ownedHost{process: command.Process, exited: true}
	if err := owned.signal(os.Kill); !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("signal after exit closure = %v, want process done", err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
}

func TestObserveOwnedProcessExitAfterChildAlreadyExited(t *testing.T) {
	command, input := ownedExitTestChild(t)
	_ = input.Close()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(time.Millisecond)
	defer poll.Stop()
	for {
		info, err := unix.SysctlKinfoProc("kern.proc.pid", command.Process.Pid)
		if err == nil && info.Proc.P_stat == 5 {
			break
		}
		select {
		case <-poll.C:
		case <-deadline.C:
			t.Fatal("child did not become waitable")
		}
	}
	observe, err := observeOwnedProcessExit(command.Process)
	if err == nil {
		observed := make(chan struct{})
		go func() { observe(); close(observed) }()
		select {
		case <-observed:
		case <-deadline.C:
			t.Fatal("observer missed an exit that preceded registration")
		}
	} else if !errors.Is(err, unix.ESRCH) {
		t.Fatalf("register already-exited child: %v", err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
}

func TestWaitForOwnedProcessExitFallsBackAfterUnexpectedEvent(t *testing.T) {
	command, input := ownedExitTestChild(t)
	queue, err := unix.Kqueue()
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(queue)
	change := unix.Kevent_t{Ident: 1, Filter: unix.EVFILT_USER, Flags: unix.EV_ADD | unix.EV_ONESHOT, Fflags: unix.NOTE_TRIGGER}
	if _, err := unix.Kevent(queue, []unix.Kevent_t{change}, nil, nil); err != nil {
		t.Fatal(err)
	}
	observed := make(chan struct{})
	go func() { waitForOwnedProcessExit(queue, command.Process.Pid); close(observed) }()
	_ = input.Close()
	select {
	case <-observed:
	case <-time.After(3 * time.Second):
		t.Fatal("unexpected one-shot event prevented the original child from being observed")
	}
	info, err := unix.SysctlKinfoProc("kern.proc.pid", command.Process.Pid)
	if err != nil || info.Proc.P_stat != 5 {
		t.Fatalf("fallback did not preserve the waitable child: info = %#v, error = %v", info, err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
}

func ownedExitTestChild(t *testing.T) (*exec.Cmd, io.Closer) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestOwnedExitChildProcess$")
	command.Env = append(os.Environ(), "HOSTLAUNCH_EXIT_CHILD=1", "HOME="+t.TempDir())
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = input.Close()
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	return command, input
}
