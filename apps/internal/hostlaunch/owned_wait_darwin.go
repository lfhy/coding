//go:build darwin

package hostlaunch

import (
	"errors"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// observeOwnedProcessExit 在回收前观察退出，弥补 Go 在 Darwin 上 Wait/Signal 的
// PID 复用竞态。NOTE_EXIT 不回收 child；调用方随后在信号锁内封闭信号入口再 Wait。
func observeOwnedProcessExit(process *os.Process) (func(), error) {
	queue, err := unix.Kqueue()
	if err != nil {
		return nil, err
	}
	unix.CloseOnExec(queue)
	change := unix.Kevent_t{
		Ident: uint64(process.Pid), Filter: unix.EVFILT_PROC,
		Flags: unix.EV_ADD | unix.EV_ONESHOT, Fflags: unix.NOTE_EXIT,
	}
	if _, err := unix.Kevent(queue, []unix.Kevent_t{change}, nil, nil); err != nil {
		_ = unix.Close(queue)
		return nil, err
	}
	return func() {
		defer unix.Close(queue)
		waitForOwnedProcessExit(queue, process.Pid)
	}, nil
}

func waitForOwnedProcessExit(queue, pid int) {
	var events [1]unix.Kevent_t
	for {
		count, err := unix.Kevent(queue, nil, events[:], nil)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err == nil && count > 0 && events[0].Flags&unix.EV_ERROR == 0 && events[0].Fflags&unix.NOTE_EXIT != 0 {
			return
		}
		if err != nil || count > 0 {
			// 异常事件可能已经消耗 EV_ONESHOT，不能再阻塞等待同一个队列。
			// 自有 child 尚未 Wait；仅确认其僵尸态后才允许封闭信号入口并回收。
			poll := time.NewTicker(10 * time.Millisecond)
			defer poll.Stop()
			for range poll.C {
				info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
				if err == nil && info.Proc.P_stat == 5 { // Darwin SZOMB。
					return
				}
			}
		}
	}
}
