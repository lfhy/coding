package remoteagent

// ProcessResolveRequest 是 POST /v1/processes/resolve 的 JSON 请求体。
// Path 是执行目录，Command 是绝对路径或 PATH 中的裸命令名。
type ProcessResolveRequest struct {
	Root    string             `json:"root,omitempty"`
	Path    string             `json:"path"`
	Command string             `json:"command"`
	Env     map[string]*string `json:"env,omitempty"`
}

// ProcessResolveResponse 返回远端执行世界中的规范可执行文件路径。
type ProcessResolveResponse struct {
	Path string `json:"path"`
}

// ProcessOutputSpec 描述一个远端输出流的保留方式。pipe 与 collect 都由
// /v1/processes/read 以原始字节提供；mode 只供本地 provider 区分交付语义。
type ProcessOutputSpec struct {
	Mode     string `json:"mode"`
	MaxBytes int64  `json:"maxBytes,omitempty"`
}

// ProcessInputSpec 描述 stdin 是关闭状态还是由 write 路由持续提供。
type ProcessInputSpec struct {
	Mode       string `json:"mode"`
	DataBase64 string `json:"dataBase64,omitempty"`
}

// ProcessStartRequest 是 POST /v1/processes/start 的 JSON 请求体。
// argv[0] 会按请求环境解析后直接交给 exec.Cmd，绝不经过 shell。
type ProcessStartRequest struct {
	Root    string             `json:"root,omitempty"`
	Path    string             `json:"path"`
	Argv    []string           `json:"argv"`
	Env     map[string]*string `json:"env,omitempty"`
	Stdin   ProcessInputSpec   `json:"stdin"`
	Stdout  ProcessOutputSpec  `json:"stdout"`
	Stderr  ProcessOutputSpec  `json:"stderr"`
	GraceMs int64              `json:"graceMs,omitempty"`
	// StartNonce 是必填的 32 位小写十六进制随机值；它让 Host 在启动响应断开后
	// 以同一请求重试，而不会创建第二棵进程树。
	StartNonce string `json:"startNonce,omitempty"`
}

// ProcessSnapshot 是一个远端进程在某一时刻的可序列化事实。
type ProcessSnapshot struct {
	ID          string  `json:"id"`
	PID         int     `json:"pid"`
	Running     bool    `json:"running"`
	Closed      bool    `json:"closed"`
	ExitCode    *int    `json:"exitCode"`
	Signal      *string `json:"signal"`
	StdinClosed bool    `json:"stdinClosed"`
	StartedAt   int64   `json:"startedAt"`
	ExitedAt    *int64  `json:"exitedAt,omitempty"`
}

// ProcessStartResponse 返回已发布进程的初始快照。
type ProcessStartResponse struct {
	Process ProcessSnapshot `json:"process"`
}

// ProcessReadRequest 是 POST /v1/processes/read 的 JSON 请求体。
// from 与 nextOffset 都是整个字节流中的偏移，不是 UTF-8 字符偏移。
type ProcessReadRequest struct {
	Root     string `json:"root,omitempty"`
	ID       string `json:"id"`
	Stream   string `json:"stream"`
	From     int64  `json:"from"`
	MaxBytes int64  `json:"maxBytes,omitempty"`
}

// ProcessReadResponse 返回一个流从 from 开始的原始字节片段。
// EOF 与 Closed 同时保留，便于不同版本的 provider 使用同一 agent。
type ProcessReadResponse struct {
	DataBase64 string          `json:"dataBase64"`
	NextOffset int64           `json:"nextOffset"`
	Lossy      bool            `json:"lossy"`
	Truncated  bool            `json:"truncated"`
	EOF        bool            `json:"eof"`
	Closed     bool            `json:"closed"`
	Process    ProcessSnapshot `json:"process"`
}

// ProcessWriteRequest 是 POST /v1/processes/write 的 JSON 请求体。
type ProcessWriteRequest struct {
	Root       string `json:"root,omitempty"`
	ID         string `json:"id"`
	DataBase64 string `json:"dataBase64"`
	CloseStdin bool   `json:"closeStdin,omitempty"`
}

// ProcessWriteResponse 报告已写入的字节数、stdin 状态和进程事实。
type ProcessWriteResponse struct {
	Written     int             `json:"written"`
	StdinClosed bool            `json:"stdinClosed"`
	Process     ProcessSnapshot `json:"process"`
}

// ProcessWaitRequest 是 POST /v1/processes/wait 的 JSON 请求体。
type ProcessWaitRequest struct {
	Root      string `json:"root,omitempty"`
	ID        string `json:"id"`
	TimeoutMs int64  `json:"timeoutMs,omitempty"`
}

// ProcessWaitResponse 返回 wait 是否在超时前观察到进程退出。
type ProcessWaitResponse struct {
	Completed bool            `json:"completed"`
	Process   ProcessSnapshot `json:"process"`
}

// ProcessKillRequest 是 POST /v1/processes/kill 的 JSON 请求体。
// SIGTERM 只发送一次信号；SIGKILL 立即结束进程树。
type ProcessKillRequest struct {
	Root   string `json:"root,omitempty"`
	ID     string `json:"id"`
	Signal string `json:"signal,omitempty"`
}

// ProcessKillResponse 返回发信号后的进程快照。
type ProcessKillResponse struct {
	Process ProcessSnapshot `json:"process"`
}
