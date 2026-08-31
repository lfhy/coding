//go:build darwin

package remoteagent

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
)

const (
	codeIsolateDarwinTaskpolicyEnv = "CODING_REMOTE_AGENT_CODE_ISOLATE_TASKPOLICY_BYTES"
	codeIsolateDarwinTaskpolicy    = "/usr/sbin/taskpolicy"
	codeIsolateMiB                 = int64(1 << 20)
)

// codeIsolatePlatformCommand 通过 macOS 的 taskpolicy 在 exec 前施加 memory
// limit。向下取整保证实际限制不会超过 Host 声明的上限；不足 1 MiB 时宁可
// 失败，也不能假装有一个比请求更宽松的限制。
func codeIsolatePlatformCommand(argv []string, limit int64) ([]string, []string, error) {
	if err := validateCodeMemoryLimit(limit); err != nil {
		return nil, nil, err
	}
	if limit < codeIsolateMiB {
		return nil, nil, errors.New("remote code isolate: Darwin memory limit must be at least 1 MiB")
	}
	info, err := os.Stat(codeIsolateDarwinTaskpolicy)
	if err != nil {
		return nil, nil, fmt.Errorf("remote code isolate: taskpolicy is unavailable: %w", err)
	}
	if info.IsDir() || info.Mode()&0o111 == 0 {
		return nil, nil, errors.New("remote code isolate: taskpolicy is not executable")
	}
	mib := limit / codeIsolateMiB
	applied := mib * codeIsolateMiB
	wrapped := make([]string, 0, len(argv)+6)
	wrapped = append(wrapped, codeIsolateDarwinTaskpolicy, "-m", strconv.FormatInt(mib, 10), "-P", "kill", "--")
	wrapped = append(wrapped, argv...)
	return wrapped, []string{codeIsolateDarwinTaskpolicyEnv + "=" + strconv.FormatInt(applied, 10)}, nil
}

// installCodeIsolateMemoryLimit 只接受由父端 taskpolicy launcher 标记的 child。
// taskpolicy 在目标 exec 之前设限；这里在读 stdin 前验证父端承诺的实际 MiB
// 值不会高于请求，缺失标记一律 fail-closed。
func installCodeIsolateMemoryLimit(limit int64) error {
	if err := validateCodeMemoryLimit(limit); err != nil {
		return err
	}
	applied, err := strconv.ParseInt(os.Getenv(codeIsolateDarwinTaskpolicyEnv), 10, 64)
	if err != nil || applied < codeIsolateMiB || applied > limit || applied%codeIsolateMiB != 0 {
		return errors.New("remote code isolate: Darwin taskpolicy limit is unavailable")
	}
	return nil
}

// attachCodeIsolateMemoryLimit 已由 taskpolicy 在 child exec 前完成。
func attachCodeIsolateMemoryLimit(_ *exec.Cmd, _ int64) (io.Closer, error) { return nil, nil }
