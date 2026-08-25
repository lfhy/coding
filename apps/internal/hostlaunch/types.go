// Package hostlaunch discovers and starts the local Coding Node Host.
package hostlaunch

import "time"

const (
	// Protocol is the version of host.json and the readiness record.
	Protocol = 1
	// DefaultStartupTimeout bounds a launch that never publishes readiness.
	DefaultStartupTimeout = 45 * time.Second
)

// Record is the JSON contract written by a managed Host.
type Record struct {
	Type     string `json:"type"`
	Port     int    `json:"port"`
	PID      int    `json:"pid"`
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	Token    string `json:"token"`
}

// Endpoint identifies a live local Host and records whether this launcher
// started its process. The process is intentionally not killed when a client
// closes; the Host owns idle shutdown.
type Endpoint struct {
	Record  Record
	BaseURL string
	Started bool
}

// Options configures discovery and a fallback Host launch.
type Options struct {
	Home           string
	Version        string
	CWD            string
	Command        []string
	StartupTimeout time.Duration
	LockTimeout    time.Duration
	PollInterval   time.Duration
	// RuntimeRoot 是桌面应用 Resources 目录。设置后，从其中的 Node 可执行文件
	// 和预展开闭包启动 Host，不回退到开发环境命令。
	RuntimeRoot string
	// OnProgress 接收 Host 在就绪前写到 stdout 的可选启动进度；nil 会忽略它。
	OnProgress func(done, total int)
}
