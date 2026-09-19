package remoteagent

// TerminalStartRequest 是 POST /v1/terminals/start 的 JSON 请求体。
// Path 受 Root 约束；Argv 直接交给 PTY，绝不经 shell 拼接。
type TerminalStartRequest struct {
	Root    string            `json:"root,omitempty"`
	Path    string            `json:"path"`
	Argv    []string          `json:"argv"`
	Env     map[string]string `json:"env,omitempty"`
	Rows    int               `json:"rows"`
	Cols    int               `json:"cols"`
	GraceMs int64             `json:"graceMs,omitempty"`
	// StartNonce 是必填的 32 位小写十六进制随机值；它让 Host 在启动响应断开后
	// 以同一请求重试，而不会创建第二个 PTY。
	StartNonce string `json:"startNonce,omitempty"`
}

// TerminalStartResponse 是一个已分配 PTY 的不透明会话引用。
type TerminalStartResponse struct {
	ID  string `json:"id"`
	PID int    `json:"pid"`
}

// TerminalReadRequest 是 POST /v1/terminals/read 的 JSON 请求体。
// After 是上次响应的 cursor；省略时读取仍保留的最早输出。
type TerminalReadRequest struct {
	Root   string `json:"root,omitempty"`
	ID     string `json:"id"`
	After  uint64 `json:"after,omitempty"`
	WaitMs int64  `json:"waitMs,omitempty"`
}

// TerminalOutputChunk 是一个严格按 sequence 交付的原始终端输出片段。
// DataBase64 使控制字符和非 UTF-8 输出不会被 JSON 文本层改变。
type TerminalOutputChunk struct {
	Sequence   uint64 `json:"sequence"`
	DataBase64 string `json:"dataBase64"`
}

// TerminalReadResponse 返回 after 之后仍保留的输出。Truncated 为 true 表示
// 请求 cursor 已落在环形缓冲区的遗失区间，调用方必须把输出视为有损。
type TerminalReadResponse struct {
	Chunks    []TerminalOutputChunk `json:"chunks"`
	Cursor    uint64                `json:"cursor"`
	Closed    bool                  `json:"closed"`
	Truncated bool                  `json:"truncated"`
	ExitCode  *int                  `json:"exitCode,omitempty"`
	Signal    string                `json:"signal,omitempty"`
}

// TerminalWriteRequest 是 POST /v1/terminals/write 的 JSON 请求体。
type TerminalWriteRequest struct {
	Root       string `json:"root,omitempty"`
	ID         string `json:"id"`
	DataBase64 string `json:"dataBase64"`
}

// TerminalResizeRequest 是 POST /v1/terminals/resize 的封闭 JSON 请求体。
type TerminalResizeRequest struct {
	Root string `json:"root,omitempty"`
	ID   string `json:"id"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// TerminalForegroundRequest 是 POST /v1/terminals/foreground 的 JSON 请求体。
type TerminalForegroundRequest struct {
	Root string `json:"root,omitempty"`
	ID   string `json:"id"`
}

// TerminalForegroundResponse 是当前控制终端公布的前台进程组事实。
type TerminalForegroundResponse struct {
	ProcessGroupID int  `json:"processGroupId"`
	InputWaiting   bool `json:"inputWaiting"`
}

// TerminalSignalRequest 是 POST /v1/terminals/signal 的 JSON 请求体。
type TerminalSignalRequest struct {
	Root   string `json:"root,omitempty"`
	ID     string `json:"id"`
	Signal string `json:"signal"`
}

// TerminalSignalResponse 是实际收到信号的前台进程组。
type TerminalSignalResponse struct {
	ProcessGroupID int `json:"processGroupId"`
}

// TerminalTerminateRequest 是 POST /v1/terminals/terminate 的 JSON 请求体。
type TerminalTerminateRequest struct {
	Root string `json:"root,omitempty"`
	ID   string `json:"id"`
}
