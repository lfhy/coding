//go:build !darwin && !linux && !windows

package remoteagent

// 不支持真实 PTY 的平台不将 pipe 假装成终端：SubprocessTerminalHandle 需要
// 控制终端和信号语义，缺失真实实现时必须在 start 明确失败。
func startTerminalBackend(_ string, _ TerminalStartRequest) (terminalBackend, error) {
	return nil, ErrTerminalUnavailable
}
