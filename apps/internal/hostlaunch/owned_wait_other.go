//go:build !darwin

package hostlaunch

import "os"

// Linux 的 pidfd/等待互斥和 Windows 的原始进程句柄由 os.Process 自身保护。
func observeOwnedProcessExit(_ *os.Process) (func(), error) { return nil, nil }
