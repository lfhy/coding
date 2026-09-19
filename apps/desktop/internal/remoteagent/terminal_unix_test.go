//go:build darwin || linux

package remoteagent

import (
	"testing"

	"github.com/creack/pty"
)

func TestUnixTerminalBackendResizeChangesPTYSize(t *testing.T) {
	shell := requireTerminalPTY(t)
	backendValue, err := startTerminalBackend(t.TempDir(), TerminalStartRequest{
		Argv: []string{shell, "-c", "while :; do sleep 1; done"},
		Rows: 24,
		Cols: 80,
	})
	if err != nil {
		t.Fatal(err)
	}
	backend := backendValue.(*unixTerminalBackend)
	t.Cleanup(func() {
		_ = backend.ForceTerminate()
		_ = backend.Close()
		_ = backend.Wait()
	})

	if err := backend.Resize(100, 30); err != nil {
		t.Fatal(err)
	}
	size, err := pty.GetsizeFull(backend.file)
	if err != nil {
		t.Fatal(err)
	}
	if size.Cols != 100 || size.Rows != 30 {
		t.Fatalf("PTY size = %dx%d, want 100x30", size.Cols, size.Rows)
	}
}
