//go:build linux

package remoteagent

import (
	"fmt"
	"io"
	"os/exec"

	"golang.org/x/sys/unix"
)

// codeIsolatePlatformCommand 保留真实 agent argv；RLIMIT_AS 必须由 child 在
// 解码首帧前设置，不能错误地限制承载 HTTP 服务的父进程。
func codeIsolatePlatformCommand(argv []string, limit int64) ([]string, []string, error) {
	if err := validateCodeMemoryLimit(limit); err != nil {
		return nil, nil, err
	}
	return argv, nil, nil
}

// installCodeIsolateMemoryLimit 在读取 program 前收紧当前 child 的地址空间。
// Setrlimit 后重新读取内核状态，避免仅把成功返回当成隔离已经生效。
func installCodeIsolateMemoryLimit(limit int64) error {
	if err := validateCodeMemoryLimit(limit); err != nil {
		return fmt.Errorf("remote code isolate: invalid Linux address-space limit: %w", err)
	}
	var current unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_AS, &current); err != nil {
		return fmt.Errorf("remote code isolate: read RLIMIT_AS: %w", err)
	}
	desired := uint64(limit)
	if current.Max != unix.RLIM_INFINITY && current.Max < desired {
		desired = current.Max
	}
	if desired == 0 {
		return fmt.Errorf("remote code isolate: RLIMIT_AS hard limit prevents isolation")
	}
	current.Cur = desired
	if err := unix.Setrlimit(unix.RLIMIT_AS, &current); err != nil {
		return fmt.Errorf("remote code isolate: set RLIMIT_AS: %w", err)
	}
	var confirmed unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_AS, &confirmed); err != nil {
		return fmt.Errorf("remote code isolate: confirm RLIMIT_AS: %w", err)
	}
	if confirmed.Cur != desired || confirmed.Cur == unix.RLIM_INFINITY || confirmed.Cur > uint64(limit) {
		return fmt.Errorf("remote code isolate: RLIMIT_AS was not enforced")
	}
	return nil
}

// attachCodeIsolateMemoryLimit 不在 Linux 父进程修改限制；child 自己在任何
// 不可信 stdin 被读取之前设置并复核 RLIMIT_AS。
func attachCodeIsolateMemoryLimit(_ *exec.Cmd, _ int64) (io.Closer, error) { return nil, nil }
