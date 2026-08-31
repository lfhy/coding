//go:build windows

package remoteagent

import (
	"bytes"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsTerminalTestWriter struct{ bytes.Buffer }

func (writer *windowsTerminalTestWriter) Close() error { return nil }

func TestWindowsTerminalPseudoForegroundDeliversCtrlC(t *testing.T) {
	input := &windowsTerminalTestWriter{}
	backend := &windowsTerminalBackend{input: input, pid: 4321}
	foreground, err := backend.Foreground()
	if err != nil || foreground != 4321 {
		t.Fatalf("foreground = %d, %v", foreground, err)
	}
	group, err := backend.SignalForeground("SIGINT")
	if err != nil || group != foreground {
		t.Fatalf("SIGINT group = %d, %v", group, err)
	}
	if got := input.Bytes(); !bytes.Equal(got, []byte{0x03}) {
		t.Fatalf("ConPTY Ctrl-C bytes = %v", got)
	}
	if _, err := backend.SignalForeground("SIGKILL"); !errors.Is(err, ErrTerminalRootKillRefused) {
		t.Fatalf("root SIGKILL = %v", err)
	}
	if _, err := backend.SignalForeground("SIGTSTP"); err == nil || !strings.Contains(err.Error(), "unsupported on Windows") {
		t.Fatalf("SIGTSTP = %v", err)
	}
}

func TestWindowsTerminalEnvironmentBlockIsDoubleNULTerminated(t *testing.T) {
	block := terminalWindowsEnvironmentBlock([]string{"Path=C:\\Tools", "TERM=xterm-256color"})
	if len(block) < 2 || block[len(block)-1] != 0 || block[len(block)-2] != 0 {
		t.Fatalf("environment block is not double-NUL terminated: %v", block)
	}
	if got := string(utf16.Decode(block[:len(block)-2])); got != "Path=C:\\Tools\x00TERM=xterm-256color" {
		t.Fatalf("environment block = %q", got)
	}
}

func TestWindowsTerminalJobEnforcesCloseKill(t *testing.T) {
	job, err := newWindowsTerminalJob()
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(job)
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
		nil,
	); err != nil {
		t.Fatal(err)
	}
	if info.BasicLimitInformation.LimitFlags&windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0 {
		t.Fatal("Job Object is missing JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE")
	}
}

func TestWindowsTerminalBackendRunsConPTY(t *testing.T) {
	command := os.Getenv("ComSpec")
	if command == "" {
		t.Skip("ComSpec is unavailable")
	}
	backend, err := startTerminalBackend(t.TempDir(), TerminalStartRequest{
		Argv: []string{command, "/D", "/Q", "/C", "echo conpty-ready"},
		Rows: 24, Cols: 80,
	})
	if errors.Is(err, ErrTerminalUnavailable) {
		t.Skip("ConPTY is unavailable on this Windows version")
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = backend.ForceTerminate()
		_ = backend.Close()
	})
	output := make(chan []byte, 1)
	go func() {
		data, _ := io.ReadAll(backend)
		output <- data
	}()
	exit := backend.Wait()
	if err := backend.Close(); err != nil {
		t.Fatal(err)
	}
	if exit.exitCode == nil || *exit.exitCode != 0 {
		t.Fatalf("ConPTY exit = %#v", exit)
	}
	if got := string(<-output); !strings.Contains(got, "conpty-ready") {
		t.Fatalf("ConPTY output = %q", got)
	}
}
