//go:build !linux && !darwin && !windows

package remoteagent

import (
	"errors"
	"io"
	"os/exec"
)

// 其它平台没有经过审计的等价进程内存限制；拒绝执行比无约束回退更安全。
func codeIsolatePlatformCommand(_ []string, _ int64) ([]string, []string, error) {
	return nil, nil, errors.New("remote code isolate: this platform has no enforceable memory limit")
}

func installCodeIsolateMemoryLimit(_ int64) error {
	return errors.New("remote code isolate: this platform has no enforceable memory limit")
}

func attachCodeIsolateMemoryLimit(_ *exec.Cmd, _ int64) (io.Closer, error) {
	return nil, errors.New("remote code isolate: this platform has no enforceable memory limit")
}
