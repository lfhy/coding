// Package remoteagent 定义桌面端与远程 Go agent 共享的最小协议。
package remoteagent

const (
	// ProtocolVersion 标识本地桌面端与远程 agent 的 HTTP 协议版本。
	ProtocolVersion = 1
)

// AgentVersion 是开发构建的 agent 版本；发布构建可通过 ldflags 覆盖。
// 它必须是变量，Go linker 才能在构建时写入值。
var AgentVersion = "dev"

// ReadyRecord 是 remote agent 在标准输出写出的唯一就绪记录。
type ReadyRecord struct {
	Type     string `json:"type"`
	Protocol int    `json:"protocol"`
	Port     int    `json:"port"`
	Version  string `json:"version"`
}

// AgentError 是远程 HTTP API 的机器可路由失败。
type AgentError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// PathInfo 描述一个远端路径；版本仅在目标存在时出现。
type PathInfo struct {
	Path    string `json:"path"`
	Type    string `json:"type"`
	Size    *int64 `json:"size,omitempty"`
	Version string `json:"version,omitempty"`
}

// DirectoryEntry 是一个目录的一层子项。
type DirectoryEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Type    string `json:"type"`
	Size    *int64 `json:"size,omitempty"`
	Version string `json:"version,omitempty"`
}

// ResolveRequest 请求把一个绝对或当前用户目录下的路径规范化。
type ResolveRequest struct {
	Root string `json:"root,omitempty"`
	Path string `json:"path"`
}

// ResolveResponse 返回规范路径及存在时的元数据。
type ResolveResponse struct {
	Path string    `json:"path"`
	Info *PathInfo `json:"info,omitempty"`
}

// StatRequest 请求目标或路径项的元数据。
type StatRequest struct {
	Root     string `json:"root,omitempty"`
	Path     string `json:"path"`
	NoFollow bool   `json:"noFollow,omitempty"`
}

// StatResponse 返回不存在或已知元数据。
type StatResponse struct {
	Info *PathInfo `json:"info,omitempty"`
}

// ListRequest 请求一个目录的一层子项。
type ListRequest struct {
	Root string `json:"root,omitempty"`
	Path string `json:"path"`
}

// ListResponse 是稳定排序后的目录项。
type ListResponse struct {
	Path    string           `json:"path"`
	Entries []DirectoryEntry `json:"entries"`
}

// ReadRequest 请求一个带完整字节上限的 UTF-8 文件。
type ReadRequest struct {
	Root     string `json:"root,omitempty"`
	Path     string `json:"path"`
	MaxBytes int64  `json:"maxBytes,omitempty"`
}

// ReadResponse 返回完整 UTF-8 内容及读取时的版本。
type ReadResponse struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Version string `json:"version"`
}

// ReadBytesResponse 返回完整原始字节的 base64 编码及读取时的版本。
type ReadBytesResponse struct {
	Path          string `json:"path"`
	ContentBase64 string `json:"contentBase64"`
	Version       string `json:"version"`
}

// WriteExpectation 指定创建或替换前提。
type WriteExpectation struct {
	Kind    string `json:"kind"`
	Version string `json:"version,omitempty"`
}

// WriteRequest 请求原子写入一个 UTF-8 文件。
type WriteRequest struct {
	Root     string            `json:"root,omitempty"`
	Path     string            `json:"path"`
	Content  string            `json:"content"`
	Expected *WriteExpectation `json:"expected,omitempty"`
}

// WriteResponse 是写入后版本和可选的展示差异基础。
type WriteResponse struct {
	Operation string  `json:"operation"`
	Version   string  `json:"version"`
	Before    *string `json:"before"`
	After     string  `json:"after"`
}

// EditRequest 请求一个字面量文本更新。
type EditRequest struct {
	Root       string            `json:"root,omitempty"`
	Path       string            `json:"path"`
	OldString  string            `json:"oldString"`
	NewString  string            `json:"newString"`
	ReplaceAll bool              `json:"replaceAll"`
	Expected   *WriteExpectation `json:"expected,omitempty"`
}

// EditResponse 是一次更新前后的完整文本及其新版本。
type EditResponse struct {
	Version string `json:"version"`
	Before  string `json:"before"`
	After   string `json:"after"`
}

// ExecRequest 请求在某个远端目录内执行一次非交互命令。
type ExecRequest struct {
	Root      string            `json:"root,omitempty"`
	Path      string            `json:"path"`
	Shell     string            `json:"shell"`
	Command   string            `json:"command"`
	TimeoutMs int               `json:"timeoutMs,omitempty"`
	Stdin     string            `json:"stdin,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
}

// ExecResponse 是一个有界前台命令的完整结算结果。
type ExecResponse struct {
	ExitCode        *int   `json:"exitCode"`
	Signal          string `json:"signal,omitempty"`
	TimedOut        bool   `json:"timedOut"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	StdoutTruncated bool   `json:"stdoutTruncated"`
	StderrTruncated bool   `json:"stderrTruncated"`
}
