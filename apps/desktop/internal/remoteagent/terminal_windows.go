//go:build windows

package remoteagent

import (
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const terminalWindowsTerminationExitCode = 1

// windowsTerminalBackend 用 ConPTY 承载真实 Windows 控制台，而不是把普通
// pipe 冒充终端。Job Object 从进程创建前就接管根进程，因而其后代无法在
// session 关闭后残留。
//
// Windows 没有 POSIX 前台进程组。为保持持久终端的 prompt-marker 协议可用，
// Foreground 把根 shell PID 作为稳定的伪前台身份：SIGINT 写入 ConPTY 的 ETX
// 让 conhost 发送 CTRL_C_EVENT；SIGTERM 终止整个受控 Job；SIGKILL 仍拒绝
// 杀掉根 shell，调用方必须使用终端会话的 terminate 路径。
type windowsTerminalBackend struct {
	input  io.WriteCloser
	output io.ReadCloser
	pid    int

	process       windows.Handle
	job           windows.Handle
	pseudoConsole windows.Handle

	mu sync.Mutex

	terminateOnce sync.Once
	terminateErr  error
	closeOnce     sync.Once
	closeErr      error
	waitOnce      sync.Once
	waitExit      terminalExit
}

func startTerminalBackend(path string, request TerminalStartRequest) (terminalBackend, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fail(400, "not-directory", "terminal path is not a directory")
	}
	environment, err := terminalEnvironment(request.Env)
	if err != nil {
		return nil, err
	}
	executable, err := processLookPath(request.Argv[0], environment, path)
	if err != nil {
		return nil, err
	}
	return startWindowsTerminal(executable, path, environment, request)
}

// startWindowsTerminal 在根进程恢复执行前把它放进 Job Object，避免 shell 在
// AssignProcessToJobObject 前抢先派生未受会话所有权约束的子进程。
func startWindowsTerminal(
	executable string,
	path string,
	environment []string,
	request TerminalStartRequest,
) (terminalBackend, error) {
	applicationName, err := windows.UTF16PtrFromString(executable)
	if err != nil {
		return nil, fmt.Errorf("remote terminal: encode executable: %w", err)
	}
	argv := make([]string, 0, len(request.Argv))
	argv = append(argv, executable)
	argv = append(argv, request.Argv[1:]...)
	commandLine, err := windows.UTF16FromString(windows.ComposeCommandLine(argv))
	if err != nil {
		return nil, fmt.Errorf("remote terminal: encode command line: %w", err)
	}
	workingDirectory, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, fmt.Errorf("remote terminal: encode working directory: %w", err)
	}
	environmentBlock := terminalWindowsEnvironmentBlock(environment)

	inputRead, inputWrite, outputRead, outputWrite, err := newWindowsTerminalPipes()
	if err != nil {
		return nil, fmt.Errorf("remote terminal: create ConPTY pipes: %w", err)
	}
	var pseudoConsole windows.Handle
	var job windows.Handle
	var processInfo windows.ProcessInformation
	cleanup := func(cause error) (terminalBackend, error) {
		if processInfo.Process != 0 {
			if job != 0 {
				_ = windows.TerminateJobObject(job, terminalWindowsTerminationExitCode)
			} else {
				_ = windows.TerminateProcess(processInfo.Process, terminalWindowsTerminationExitCode)
			}
		}
		closeWindowsTerminalHandle(&inputRead)
		closeWindowsTerminalHandle(&inputWrite)
		closeWindowsTerminalHandle(&outputRead)
		closeWindowsTerminalHandle(&outputWrite)
		closeWindowsTerminalHandle(&processInfo.Thread)
		closeWindowsTerminalHandle(&processInfo.Process)
		closeWindowsTerminalHandle(&job)
		closeWindowsPseudoConsoleAsync(pseudoConsole)
		return nil, cause
	}

	if err := windows.CreatePseudoConsole(
		windows.Coord{X: int16(request.Cols), Y: int16(request.Rows)}, inputRead, outputWrite, 0, &pseudoConsole,
	); err != nil {
		if terminalWindowsUnavailable(err) {
			return cleanup(ErrTerminalUnavailable)
		}
		return cleanup(fmt.Errorf("remote terminal: create ConPTY: %w", err))
	}
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return cleanup(fmt.Errorf("remote terminal: allocate ConPTY startup attributes: %w", err))
	}
	defer attributes.Delete()
	if err := attributes.Update(
		windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
		unsafe.Pointer(&pseudoConsole),
		unsafe.Sizeof(pseudoConsole),
	); err != nil {
		return cleanup(fmt.Errorf("remote terminal: attach ConPTY startup attribute: %w", err))
	}
	job, err = newWindowsTerminalJob()
	if err != nil {
		return cleanup(err)
	}
	startupInfo := windows.StartupInfoEx{
		StartupInfo:             windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfoEx{}))},
		ProcThreadAttributeList: attributes.List(),
	}
	flags := uint32(windows.CREATE_DEFAULT_ERROR_MODE | windows.CREATE_UNICODE_ENVIRONMENT |
		windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_SUSPENDED)
	if err := windows.CreateProcess(
		applicationName,
		&commandLine[0],
		nil,
		nil,
		false,
		flags,
		&environmentBlock[0],
		workingDirectory,
		&startupInfo.StartupInfo,
		&processInfo,
	); err != nil {
		runtime.KeepAlive(commandLine)
		runtime.KeepAlive(environmentBlock)
		return cleanup(fmt.Errorf("remote terminal: start ConPTY client: %w", err))
	}
	runtime.KeepAlive(commandLine)
	runtime.KeepAlive(environmentBlock)
	// Microsoft 要求 CreateProcess 返回后释放交给 ConPTY 的两个 pipe 端，
	// 否则会额外保留引用，令关闭后的 EOF 与 broken-pipe 无法被可靠观察。
	closeWindowsTerminalHandle(&inputRead)
	closeWindowsTerminalHandle(&outputWrite)
	if err := windows.AssignProcessToJobObject(job, processInfo.Process); err != nil {
		return cleanup(fmt.Errorf("remote terminal: assign ConPTY client to Job Object: %w", err))
	}
	if _, err := windows.ResumeThread(processInfo.Thread); err != nil {
		return cleanup(fmt.Errorf("remote terminal: resume ConPTY client: %w", err))
	}
	closeWindowsTerminalHandle(&processInfo.Thread)
	input := os.NewFile(uintptr(inputWrite), "remote-terminal-conpty-input")
	if input == nil {
		return cleanup(errors.New("remote terminal: convert ConPTY input handle to file"))
	}
	inputWrite = 0
	output := os.NewFile(uintptr(outputRead), "remote-terminal-conpty-output")
	if output == nil {
		_ = input.Close()
		return cleanup(errors.New("remote terminal: convert ConPTY output handle to file"))
	}
	outputRead = 0

	return &windowsTerminalBackend{
		input: input, output: output, pid: int(processInfo.ProcessId),
		process: processInfo.Process, job: job, pseudoConsole: pseudoConsole,
	}, nil
}

func (backend *windowsTerminalBackend) Read(data []byte) (int, error) {
	return backend.output.Read(data)
}

func (backend *windowsTerminalBackend) Write(data []byte) (int, error) {
	return backend.input.Write(data)
}

func (backend *windowsTerminalBackend) Resize(cols, rows int) error {
	if err := validateTerminalSize(cols, rows); err != nil {
		return err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.pseudoConsole == 0 {
		return ErrTerminalClosed
	}
	if err := windows.ResizePseudoConsole(
		backend.pseudoConsole,
		windows.Coord{X: int16(cols), Y: int16(rows)},
	); err != nil {
		return fmt.Errorf("remote terminal: resize ConPTY: %w", err)
	}
	return nil
}

// Close 先关闭 host 侧输出 pipe，再异步释放 ConPTY。Windows 11 24H2 前的
// ClosePseudoConsole 可能无限等待 client 断开；输出 pipe 已关闭且 Job 已强杀
// 树后，后台释放不会阻塞 HTTP session 的回收路径。
func (backend *windowsTerminalBackend) Close() error {
	backend.closeOnce.Do(func() {
		terminateErr := backend.terminateJob()
		inputErr := backend.input.Close()
		outputErr := backend.output.Close()
		backend.mu.Lock()
		job := backend.job
		backend.job = 0
		pseudoConsole := backend.pseudoConsole
		backend.pseudoConsole = 0
		backend.mu.Unlock()
		if job != 0 {
			jobErr := windows.CloseHandle(job)
			backend.closeErr = errors.Join(terminateErr, inputErr, outputErr, jobErr)
		} else {
			backend.closeErr = errors.Join(terminateErr, inputErr, outputErr)
		}
		closeWindowsPseudoConsoleAsync(pseudoConsole)
	})
	return backend.closeErr
}

func (backend *windowsTerminalBackend) PID() int { return backend.pid }

func (backend *windowsTerminalBackend) Wait() terminalExit {
	backend.waitOnce.Do(func() {
		if backend.process == 0 {
			return
		}
		result, err := windows.WaitForSingleObject(backend.process, windows.INFINITE)
		if err == nil && result == windows.WAIT_OBJECT_0 {
			var code uint32
			if windows.GetExitCodeProcess(backend.process, &code) == nil && uint64(code) <= uint64(^uint(0)>>1) {
				exitCode := int(code)
				backend.waitExit = terminalExit{exitCode: &exitCode}
			}
		}
		_ = windows.CloseHandle(backend.process)
		backend.process = 0
	})
	return backend.waitExit
}

// Foreground 返回根 shell 的 Windows 伪前台身份，不把它声称为 POSIX pgid。
func (backend *windowsTerminalBackend) Foreground() (int, error) {
	if backend.pid <= 0 {
		return 0, ErrTerminalNoForeground
	}
	return backend.pid, nil
}

func (backend *windowsTerminalBackend) SignalForeground(signal string) (int, error) {
	group, err := backend.Foreground()
	if err != nil {
		return 0, err
	}
	if signal == "SIGKILL" {
		return 0, ErrTerminalRootKillRefused
	}
	switch signal {
	case "SIGINT":
		// ConPTY 会把 ETX 转换为当前控制台 client 的 CTRL_C_EVENT；这比
		// Windows 上不存在的进程组 kill 更接近交互式 Ctrl-C。
		if err := writeTerminalAll(backend, []byte{0x03}); err != nil {
			return 0, err
		}
		return group, nil
	case "SIGTERM":
		if err := backend.Terminate(); err != nil {
			return 0, err
		}
		return group, nil
	default:
		return 0, fmt.Errorf("remote terminal: signal %s is unsupported on Windows; only SIGINT, SIGTERM, and SIGKILL are available", signal)
	}
}

// Terminate 没有伪造 SIGTERM：Windows Job Object 只能可靠保证树级终止，
// 由 session 层将其作为 Windows 的终端停止语义处理。
func (backend *windowsTerminalBackend) Terminate() error {
	backend.terminateOnce.Do(func() { backend.terminateErr = backend.terminateJob() })
	return backend.terminateErr
}

// ForceTerminate 直接终止受 Job Object 约束的整棵进程树。
func (backend *windowsTerminalBackend) ForceTerminate() error {
	return backend.terminateJob()
}

func (backend *windowsTerminalBackend) terminateJob() error {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.job == 0 {
		return nil
	}
	if err := windows.TerminateJobObject(backend.job, terminalWindowsTerminationExitCode); err != nil {
		return fmt.Errorf("remote terminal: terminate Job Object: %w", err)
	}
	return nil
}

func newWindowsTerminalPipes() (windows.Handle, windows.Handle, windows.Handle, windows.Handle, error) {
	var inputRead, inputWrite, outputRead, outputWrite windows.Handle
	if err := windows.CreatePipe(&inputRead, &inputWrite, nil, 0); err != nil {
		return 0, 0, 0, 0, err
	}
	if err := windows.CreatePipe(&outputRead, &outputWrite, nil, 0); err != nil {
		closeWindowsTerminalHandle(&inputRead)
		closeWindowsTerminalHandle(&inputWrite)
		return 0, 0, 0, 0, err
	}
	return inputRead, inputWrite, outputRead, outputWrite, nil
}

// newWindowsTerminalJob 配置 close-kill 并立即回读确认。不能确认 containment
// 时拒绝启动，避免退化成只会杀根 shell 的普通 Windows 子进程。
func newWindowsTerminalJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("remote terminal: create Job Object: %w", err)
	}
	failJob := func(cause error) (windows.Handle, error) {
		_ = windows.CloseHandle(job)
		return 0, cause
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		return failJob(fmt.Errorf("remote terminal: configure Job Object: %w", err))
	}
	var confirmed windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&confirmed)),
		uint32(unsafe.Sizeof(confirmed)),
		nil,
	); err != nil {
		return failJob(fmt.Errorf("remote terminal: verify Job Object: %w", err))
	}
	if confirmed.BasicLimitInformation.LimitFlags&windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0 {
		return failJob(errors.New("remote terminal: Job Object close-kill was not enforced"))
	}
	return job, nil
}

func terminalEnvironment(explicit map[string]string) ([]string, error) {
	environment, err := commandEnvironment(explicit)
	if err != nil {
		return nil, err
	}
	if _, found := processEnvironmentValue(environment, "TERM"); found {
		return environment, nil
	}
	return append(environment, "TERM=xterm-256color"), nil
}

// terminalWindowsEnvironmentBlock 以 Windows 要求的双 NUL UTF-16 环境块编码。
func terminalWindowsEnvironmentBlock(environment []string) []uint16 {
	block := utf16.Encode([]rune(strings.Join(environment, "\x00")))
	return append(block, 0, 0)
}

func terminalWindowsUnavailable(err error) bool {
	if errors.Is(err, windows.ERROR_PROC_NOT_FOUND) ||
		errors.Is(err, windows.ERROR_CALL_NOT_IMPLEMENTED) ||
		errors.Is(err, windows.ERROR_NOT_SUPPORTED) {
		return true
	}
	// CreatePseudoConsole 返回 HRESULT，而 x/sys 按 Errno 暴露其原始位模式；
	// ERROR_NOT_SUPPORTED 等 HRESULT_FROM_WIN32 值需还原低 16 位才能分类。
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	code := uint32(errno)
	if code&0xffff0000 == 0x80070000 {
		code &= 0xffff
	}
	return code == uint32(windows.ERROR_PROC_NOT_FOUND) ||
		code == uint32(windows.ERROR_CALL_NOT_IMPLEMENTED) ||
		code == uint32(windows.ERROR_NOT_SUPPORTED) ||
		code == 0x80004001 // E_NOTIMPL
}

func closeWindowsTerminalHandle(handle *windows.Handle) {
	if *handle != 0 && *handle != windows.InvalidHandle {
		_ = windows.CloseHandle(*handle)
	}
	*handle = 0
}

func closeWindowsPseudoConsoleAsync(pseudoConsole windows.Handle) {
	if pseudoConsole == 0 || pseudoConsole == windows.InvalidHandle {
		return
	}
	go windows.ClosePseudoConsole(pseudoConsole)
}
