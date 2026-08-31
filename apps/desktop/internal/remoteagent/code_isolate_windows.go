//go:build windows

package remoteagent

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

const codeIsolateWindowsJobEnv = "CODING_REMOTE_AGENT_CODE_ISOLATE_WINDOWS_JOB_BYTES"

// codeIsolatePlatformCommand 让 child 在首帧前等待父端把它放进 Job Object。
func codeIsolatePlatformCommand(argv []string, limit int64) ([]string, []string, error) {
	if err := validateCodeMemoryLimit(limit); err != nil {
		return nil, nil, fmt.Errorf("remote code isolate: invalid Windows memory limit: %w", err)
	}
	return argv, []string{codeIsolateWindowsJobEnv + "=" + strconv.FormatInt(limit, 10)}, nil
}

// installCodeIsolateMemoryLimit 仅允许父端承诺建立 Job Object 的 child 继续。
// 真正的限额在父端 Start 后、写入首帧前通过 AssignProcessToJobObject 生效。
func installCodeIsolateMemoryLimit(limit int64) error {
	if err := validateCodeMemoryLimit(limit); err != nil {
		return err
	}
	configured, err := strconv.ParseInt(os.Getenv(codeIsolateWindowsJobEnv), 10, 64)
	if err != nil || configured != limit || configured <= 0 {
		return errors.New("remote code isolate: Windows Job Object limit is unavailable")
	}
	return nil
}

type codeIsolateJob struct{ handle windows.Handle }

func (job *codeIsolateJob) Close() error {
	if job == nil || job.handle == 0 {
		return nil
	}
	err := windows.CloseHandle(job.handle)
	job.handle = 0
	return err
}

// attachCodeIsolateMemoryLimit 把已启动但仍阻塞在 stdin 的 child 放入带硬
// process-memory limit 与 close-kill 语义的 Job Object。任何 API 失败都会由
// 调用方在写入 program 前杀死 child，避免无约束执行窗口。
func attachCodeIsolateMemoryLimit(command *exec.Cmd, limit int64) (io.Closer, error) {
	if command == nil || command.Process == nil {
		return nil, errors.New("remote code isolate: invalid Windows Job Object limit")
	}
	if err := validateCodeMemoryLimit(limit); err != nil {
		return nil, fmt.Errorf("remote code isolate: invalid Windows Job Object limit: %w", err)
	}
	if uint64(limit) > uint64(^uintptr(0)) {
		return nil, errors.New("remote code isolate: invalid Windows Job Object limit")
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("remote code isolate: create Job Object: %w", err)
	}
	fail := func(cause error) (io.Closer, error) {
		_ = windows.CloseHandle(job)
		return nil, cause
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
		return fail(fmt.Errorf("remote code isolate: query Job Object: %w", err))
	}
	info.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_PROCESS_MEMORY | windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	info.ProcessMemoryLimit = uintptr(limit)
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		return fail(fmt.Errorf("remote code isolate: set Job Object: %w", err))
	}
	var confirmed windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&confirmed)), uint32(unsafe.Sizeof(confirmed)), nil); err != nil {
		return fail(fmt.Errorf("remote code isolate: confirm Job Object: %w", err))
	}
	flags := confirmed.BasicLimitInformation.LimitFlags
	if flags&windows.JOB_OBJECT_LIMIT_PROCESS_MEMORY == 0 || flags&windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0 || confirmed.ProcessMemoryLimit != uintptr(limit) {
		return fail(errors.New("remote code isolate: Job Object limit was not enforced"))
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(command.Process.Pid))
	if err != nil {
		return fail(fmt.Errorf("remote code isolate: open child process: %w", err))
	}
	defer windows.CloseHandle(process)
	if err := windows.AssignProcessToJobObject(job, process); err != nil {
		return fail(fmt.Errorf("remote code isolate: assign child Job Object: %w", err))
	}
	return &codeIsolateJob{handle: job}, nil
}
